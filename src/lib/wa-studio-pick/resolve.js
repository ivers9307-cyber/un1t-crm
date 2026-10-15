// WASTUDIOPICK.1 — decide an unknown WhatsApp sender's studio (spec R1-R7).
// Called once per inbound message by the webhook, after the message is stored
// and before Mia. Never throws: any failure is logged and the message carries
// on at the thread's studio, exactly as before this existed.
import { sendInteractiveOptions } from '@/lib/whatsapp'
import { AGENT_MESSAGE_SOURCE, stripEmDashes } from '@/lib/agent/core'
import { logWarn, logError } from '../log'
import { readPickerConfig, PICKER_ID_PREFIX } from './config'
import { adSignal, replySignal, tapSignal } from './signals'
import { classifyStudio } from './classify'

// Only these two statuses end the conversation's resolution. 'asked' has its
// own branch; anything else (null, a malformed value) behaves like no record.
const FINAL = new Set(['decided', 'unresolved'])
const TEXT_TYPES = new Set(['text', 'interactive', 'image', 'video', 'document'])

async function record(db, conversationId, resolution) {
  const { error } = await db.from('whatsapp_conversations')
    .update({ studio_resolution: { ...resolution, at: new Date().toISOString() } }).eq('id', conversationId)
  if (error) logError('wa-studio-pick', 'studio_resolution write failed', { conversationId, err: error.message })
}

async function decide(db, ctx, studioId, by) {
  let { conversationId } = ctx
  let locationId = ctx.threadLocationId
  if (studioId !== ctx.threadLocationId) {
    const { data, error } = await db.rpc('move_whatsapp_conversation', { p_conversation_id: conversationId, p_target_location_id: studioId })
    if (error) {
      logError('wa-studio-pick', 'move failed; thread stays', { conversationId, studioId, err: error.message })
      await record(db, conversationId, { status: 'unresolved', reason: 'move_failed', by, location_id: studioId })
      return { action: 'unresolved', locationId, conversationId }
    }
    conversationId = data?.conversation_id || conversationId
    locationId = studioId
  }
  await record(db, conversationId, { status: 'decided', by, location_id: studioId })
  return { action: 'decided', locationId, conversationId }
}

async function ask(db, ctx, cfg) {
  const question = stripEmDashes(cfg.question)
  const options = cfg.studios.map((s) => ({ id: `${PICKER_ID_PREFIX}${s.id}`, title: s.label }))
  try {
    const sent = await sendInteractiveOptions(ctx.senderPhone, question, options,
      { locationId: ctx.threadLocationId, replyInConversation: ctx.conversationId })
    const { error } = await db.from('whatsapp_messages').insert({
      conversation_id: ctx.conversationId, contact_id: null, location_id: ctx.threadLocationId,
      wa_message_id: sent?.messageId || null, direction: 'outbound', message_type: 'interactive',
      body: question, status: 'sent', source: AGENT_MESSAGE_SOURCE, sent_at: new Date().toISOString(),
    })
    if (error) logError('wa-studio-pick', 'picker sent but not logged', { conversationId: ctx.conversationId, err: error.message })
    await record(db, ctx.conversationId, { status: 'asked' })
    return { action: 'asked', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
  } catch (e) {
    logWarn('wa-studio-pick', 'picker send failed; carrying on', { conversationId: ctx.conversationId, err: e?.message || String(e) })
    await record(db, ctx.conversationId, { status: 'unresolved', reason: 'ask_failed' })
    return { action: 'unresolved', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
  }
}

export async function resolveNewSenderStudio(db, ctx) {
  const skip = { action: 'skip', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
  try {
    if (ctx.contactId || ctx.threadLocationId !== ctx.receivingLocationId) return skip
    const status = ctx.resolution?.status || null
    if (status && FINAL.has(status)) return skip
    const cfg = await readPickerConfig(db, ctx.receivingLocationId)
    if (!cfg?.enabled || cfg.studios.length < 2) return skip
    const ids = cfg.studios.map((s) => s.id)
    const hasText = TEXT_TYPES.has(ctx.messageType) && String(ctx.body || '').trim() && !String(ctx.body).startsWith('[')

    if (status === 'asked') {
      const tapped = tapSignal(ctx.message, ids)
      if (tapped) return await decide(db, ctx, tapped, 'picker')
      if (hasText) {
        const c = await classifyStudio({ text: ctx.body, studios: cfg.studios, locationId: ctx.receivingLocationId })
        if (c.studioId) return await decide(db, ctx, c.studioId, 'ai')
      }
      await record(db, ctx.conversationId, { status: 'unresolved', reason: 'no_answer' })
      return { action: 'unresolved', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
    }

    const fromAd = await adSignal(db, ctx.message?.referral, ids)
    if (fromAd) return await decide(db, ctx, fromAd, 'ad')
    const fromReply = await replySignal(db, ctx.message?.context?.id, ids)
    if (fromReply) return await decide(db, ctx, fromReply, 'reply')
    if (hasText) {
      const c = await classifyStudio({ text: ctx.body, studios: cfg.studios, locationId: ctx.receivingLocationId })
      if (c.studioId) return await decide(db, ctx, c.studioId, 'ai')
    }
    return await ask(db, ctx, cfg)
  } catch (e) {
    logError('wa-studio-pick', 'resolver failed; carrying on', { conversationId: ctx.conversationId, err: e?.message || String(e) })
    return skip
  }
}
