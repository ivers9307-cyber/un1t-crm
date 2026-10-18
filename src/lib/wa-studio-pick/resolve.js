// WASTUDIOPICK.1 — decide an unknown WhatsApp sender's studio (spec R1-R7).
// Called once per inbound message by the webhook, after the message is stored
// and before Mia. Never throws: any failure is logged and the message carries
// on at the thread's studio, exactly as before this existed.
import { sendInteractiveOptions } from '@/lib/whatsapp'
import { AGENT_MESSAGE_SOURCE, stripEmDashes } from '@/lib/agent/core'
import { logInfo, logWarn, logError } from '../log'
import { readPickerConfig, PICKER_ID_PREFIX } from './config'
import { adSignal, replySignal, tapSignal } from './signals'
import { classifyStudio } from './classify'

// Only these two statuses end the conversation's resolution. 'asked' has its
// own branch; anything else (null, a malformed value) behaves like no record.
const FINAL = new Set(['decided', 'unresolved'])
// 'button' is a template quick-reply tap: WABUTTONTAP.1 stores its readable text.
const TEXT_TYPES = new Set(['text', 'interactive', 'button', 'image', 'video', 'document'])
// After the picker, these cannot answer it: they must not burn the one question.
const NON_ANSWER_TYPES = new Set(['reaction', 'sticker', 'audio', 'unsupported', 'system', 'request_welcome'])
// A final write only lands while the row is unresolved or still asking, so a
// burst's slower message can never overwrite a decision another one finished.
const NOT_FINAL = 'studio_resolution.is.null,studio_resolution->>status.eq.asked'
// The claim stamps `at` just before the picker is sent; anything the customer
// sent up to this long after it was typed before the question reached them.
const SENT_BEFORE_PICKER_MS = 5000

// True only when both times parse and the message (Meta's unix-seconds
// `timestamp`) is at or before the claim + grace. Unparseable → false, so the
// message is judged as an answer, as before this rule existed.
function sentBeforePicker(message, resolution) {
  const ts = Number(message?.timestamp)
  const at = Date.parse(resolution?.at)
  if (!message?.timestamp || !Number.isFinite(ts) || !Number.isFinite(at)) return false
  return ts * 1000 <= at + SENT_BEFORE_PICKER_MS
}

async function record(db, conversationId, resolution) {
  const { data, error } = await db.from('whatsapp_conversations')
    .update({ studio_resolution: { ...resolution, at: new Date().toISOString() } })
    .eq('id', conversationId).or(NOT_FINAL).select('id')
  if (error) logError('wa-studio-pick', 'studio_resolution write failed', { conversationId, err: error.message })
  else if (!data?.length) logInfo('wa-studio-pick', 'resolution already final; write skipped', { conversationId })
}

async function decide(db, ctx, studioId, by) {
  let { conversationId } = ctx
  let locationId = ctx.threadLocationId
  if (studioId !== ctx.threadLocationId) {
    const { data, error } = await db.rpc('move_whatsapp_conversation', { p_conversation_id: conversationId, p_target_location_id: studioId })
    if (error && String(error.message || '').includes('same_studio')) {
      // A burst sibling already moved this thread there: that is the goal.
      locationId = studioId
    } else if (error) {
      logError('wa-studio-pick', 'move failed; thread stays', { conversationId, studioId, err: error.message })
      await record(db, conversationId, { status: 'unresolved', reason: 'move_failed', by, location_id: studioId })
      return { action: 'unresolved', locationId, conversationId }
    } else {
      conversationId = data?.conversation_id || conversationId
      locationId = studioId
    }
  }
  await record(db, conversationId, { status: 'decided', by, location_id: studioId })
  return { action: 'decided', locationId, conversationId }
}

async function ask(db, ctx, cfg) {
  const { conversationId, threadLocationId } = ctx
  // Claim the question BEFORE sending: a compare-and-set on a still-null
  // resolution, so a burst of first messages sends exactly one picker.
  const { data: claimed, error: claimError } = await db.from('whatsapp_conversations')
    .update({ studio_resolution: { status: 'asked', at: new Date().toISOString() } })
    .eq('id', conversationId).is('studio_resolution', null).select('id')
  if (claimError) {
    logError('wa-studio-pick', 'picker claim failed; carrying on', { conversationId, err: claimError.message })
    return { action: 'skip', locationId: threadLocationId, conversationId }
  }
  // Another message owns the question: stay quiet, it is already on its way.
  if (!claimed?.length) return { action: 'asked', locationId: threadLocationId, conversationId }

  const question = stripEmDashes(cfg.question)
  const options = cfg.studios.map((s) => ({ id: `${PICKER_ID_PREFIX}${s.id}`, title: stripEmDashes(s.label) }))
  let sent
  try {
    sent = await sendInteractiveOptions(ctx.senderPhone, question, options,
      { locationId: threadLocationId, replyInConversation: conversationId })
  } catch (e) {
    logWarn('wa-studio-pick', 'picker send failed; carrying on', { conversationId, err: e?.message || String(e) })
    // We own the claim, so this overwrite is unconditional.
    const { error } = await db.from('whatsapp_conversations')
      .update({ studio_resolution: { status: 'unresolved', reason: 'ask_failed', at: new Date().toISOString() } }).eq('id', conversationId)
    if (error) logError('wa-studio-pick', 'studio_resolution write failed', { conversationId, err: error.message })
    return { action: 'unresolved', locationId: threadLocationId, conversationId }
  }
  // The picker is out. A failed log row is reported, never allowed to undo that.
  const { error } = await db.from('whatsapp_messages').insert({
    conversation_id: conversationId, contact_id: null, location_id: threadLocationId,
    wa_message_id: sent?.messageId || null, direction: 'outbound', message_type: 'interactive',
    body: question, status: 'sent', source: AGENT_MESSAGE_SOURCE, sent_at: new Date().toISOString(),
  })
  if (error) logError('wa-studio-pick', 'picker sent but not logged', { conversationId, err: error.message })
  return { action: 'asked', locationId: threadLocationId, conversationId }
}

// F7 — a customer who only ever sends voice notes must not stay 'asked'
// forever (Mia stays quiet while asked). First non-answer: count it on the
// still-asked row, keeping the original `at` the F1 rule reads. Second: final.
async function nonAnswer(db, ctx) {
  const { conversationId, threadLocationId } = ctx
  if (Number(ctx.resolution?.nonanswers) >= 1) {
    await record(db, conversationId, { status: 'unresolved', reason: 'no_answer' })
    return { action: 'unresolved', locationId: threadLocationId, conversationId }
  }
  const { data, error } = await db.from('whatsapp_conversations')
    .update({ studio_resolution: { status: 'asked', at: ctx.resolution?.at, nonanswers: 1 } })
    .eq('id', conversationId).filter('studio_resolution->>status', 'eq', 'asked').select('id')
  if (error) logError('wa-studio-pick', 'non-answer count write failed', { conversationId, err: error.message })
  else if (!data?.length) logInfo('wa-studio-pick', 'no longer asked; non-answer not counted', { conversationId })
  return { action: 'asked', locationId: threadLocationId, conversationId }
}

export async function resolveNewSenderStudio(db, ctx) {
  const skip = { action: 'skip', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
  try {
    if (ctx.contactId || ctx.threadLocationId !== ctx.receivingLocationId) return skip
    const status = ctx.resolution?.status || null
    if (status && FINAL.has(status)) return skip
    const cfg = await readPickerConfig(db, ctx.receivingLocationId, ctx.receivingNumberId)
    if (!cfg?.enabled || cfg.studios.length < 2) return skip
    const ids = cfg.studios.map((s) => s.id)
    const hasText = TEXT_TYPES.has(ctx.messageType) && String(ctx.body || '').trim()
      && !(ctx.messageType === 'interactive' && ctx.message?.interactive?.type === 'nfm_reply')

    if (status === 'asked') {
      const tapped = tapSignal(ctx.message, ids)
      if (tapped) return await decide(db, ctx, tapped, 'picker')
      // Typed before the question reached them: not an answer. Mia stays quiet
      // and answers with the whole history once the thread resolves (R7).
      if (sentBeforePicker(ctx.message, ctx.resolution)) return { action: 'asked', locationId: ctx.threadLocationId, conversationId: ctx.conversationId }
      // A reaction, sticker, voice note... cannot answer. The first one leaves
      // the question open; a second ends it so Mia is not silent for good.
      if (NON_ANSWER_TYPES.has(ctx.messageType)) return await nonAnswer(db, ctx)
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
