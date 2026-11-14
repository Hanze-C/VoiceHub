import { releaseCardCodeAfterSongWithdrawal } from '~~/server/services/cardCodeLifecycleService'
import { db } from '~/drizzle/db'
import { schedules, songBlacklists, songs, votes, requestTimes } from '~/drizzle/schema'
import { eq, sql } from 'drizzle-orm'
import { createSongRejectedNotification } from '../../../services/notificationService'
import { recordAdminAudit } from '~~/server/utils/admin-audit'
import { createApiError } from '~~/server/utils/apiError'
import { SERVER_ERROR_CODES } from '~~/server/config/constants'
import { getAllowRejectWithoutReason } from '~~/server/utils/system-settings-helper'

export default defineEventHandler(async (event) => {
  const user = event.context.user

  const body = await readBody(event)
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

  if (!body.songId) {
    throw createError({
      statusCode: 400,
      message: '歌曲ID不能为空'
    })
  }

  if (!reason && !(await getAllowRejectWithoutReason())) {
    throw createApiError(400, SERVER_ERROR_CODES.SONG_REJECT_REASON_REQUIRED, '驳回原因不能为空')
  }

  try {
    let songForNotification = null

    // 使用事务确保驳回操作的原子性
    const result = await db.transaction(async (tx) => {
      // 在事务中重新检查歌曲是否存在
      const songResult = await tx.select().from(songs).where(eq(songs.id, body.songId)).limit(1).for('update')
      const song = songResult[0]

      if (!song) {
        throw createError({
          statusCode: 404,
          message: '歌曲不存在或已被删除'
        })
      }

      // 保存歌曲信息用于后续发送通知
      songForNotification = song

      console.log(`开始驳回歌曲: ${song.title} (ID: ${body.songId})`)

      // 如果选择加入黑名单，先添加到黑名单
      if (body.addToBlacklist) {
        try {
          await tx.insert(songBlacklists).values({
            type: 'SONG',
            value: `${song.title} - ${song.artist}`,
            reason: reason ? `歌曲驳回: ${reason}` : '歌曲驳回',
            createdBy: user.id
          })
          console.log(`歌曲已添加到黑名单`)
        } catch (error) {
          // 如果黑名单中已存在相同歌曲，忽略错误继续执行
          console.log(`黑名单添加失败，可能已存在: ${error.message}`)
        }
      }

      // 删除歌曲的所有投票
      await tx.delete(votes).where(eq(votes.songId, body.songId))
      console.log(`删除了投票记录`)

      await releaseCardCodeAfterSongWithdrawal(tx, {
        songId: song.id, cardCodeId: song.cardCodeId, operatorId: user.id, removeSong: true
      })
      // 删除歌曲的所有排期
      await tx.delete(schedules).where(eq(schedules.songId, body.songId))
      console.log(`删除了排期记录`)

      // 如果有 hitRequestId，减少对应时段的已接纳数量
      if (song.hitRequestId) {
        try {
          await tx
            .update(requestTimes)
            .set({
              accepted: sql`GREATEST(0, accepted - 1)`
            })
            .where(eq(requestTimes.id, song.hitRequestId))
          console.log(`已减少投稿时段 ${song.hitRequestId} 的接纳数量`)
        } catch (error) {
          console.error(`减少投稿时段接纳数量失败: ${error.message}`)
        }
      }

      // 删除歌曲
      const deletedSong = await tx.delete(songs).where(eq(songs.id, body.songId)).returning()
      console.log(`歌曲删除完成`)

      return {
        success: true,
        deletedSong: deletedSong[0],
        addedToBlacklist: body.addToBlacklist
      }
    })

    // 事务提交后，发送通知
    // 这样避免邮件发送等耗时操作阻塞数据库事务连接
    let notificationSent = false
    if (songForNotification && songForNotification.requesterId) {
      // 异步发送通知，不阻塞响应
      createSongRejectedNotification(
        songForNotification.requesterId,
        { title: songForNotification.title, artist: songForNotification.artist },
        reason
      )
        .then(() => {
          console.log(`已发送驳回通知给用户: ${songForNotification.requesterId}`)
        })
        .catch((error) => {
          console.error(`发送通知失败: ${error.message}`)
        })

      notificationSent = true
    }

    console.log(`歌曲驳回操作完成: ${body.songId}`)

    await recordAdminAudit(event, 'song.reject', {
      targetType: 'song',
      targetId: body.songId,
      summary: {
        title: result.deletedSong?.title,
        artist: result.deletedSong?.artist,
        reason,
        addedToBlacklist: body.addToBlacklist
      }
    })

    return {
      success: true,
      message: '歌曲驳回成功',
      data: {
        ...result,
        notificationSent
      }
    }
  } catch (error) {
    console.error('驳回歌曲失败:', error)

    // 如果是我们抛出的错误，直接重新抛出
    if (error.statusCode) {
      throw error
    }

    // 其他错误
    throw createError({
      statusCode: 500,
      message: '驳回歌曲失败: ' + error.message
    })
  }
})
