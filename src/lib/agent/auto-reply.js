// RADAR-AGENT — customer-agent auto-reply orchestrator (IO).
//
// Channel-agnostic. The shared brain (settings gate, knowledge,
// history, the Anthropic tool-use loop, parse, handoff) lives in
// runChannelAgent(); a per-channel ADAPTER supplies the table names,
// the send function, the row shapes, and the notification labels. The
// pure decisions/formatting are in core.js / prompt.js, and the
// account-answer tools are in account-tools.js.
//
// Channels today:
//   - WhatsApp: maybeAutoReply(), called from the WhatsApp webhook.
//   - Instagram: handleInstagramInbound() in instagram.js calls
//     runChannelAgent() directly with the instagramAdapter.
// Both reuse the exact same runner — only the adapter differs.
//
// Safety posture: gated OFF by default (locations.settings
// .customer_agent) + test-mode allow-list; the only actions are
// READ-ONLY account lookups behind server-enforced identity
// verification (account-tools.js). Answers from knowledge or hands off.
// Never throws.

import { sendTextMessage, sendInteractiveOptions, sendTypingIndicator } from '@/lib/whatsapp'
import { dublinTodayStr } from '@/lib/dublin-time'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { buildCachedSystem } from './prompt'
import { getLocationBranding } from '@/lib/location-branding'
import {
  shouldAgentReply,
  formatHistoryForClaude,
  parseAgentResponse,
  isVerificationFresh,
  resolveAgentEffort,
  AGENT_MESSAGE_SOURCE,
  DEFAULT_HOLDING_MESSAGE,
  resolveAutoVerify,
  resolveActingContactId,
} from './core'
import { personGroupResolver } from '@/lib/person-links'
import { ACCOUNT_TOOLS, ACCOUNT_TOOL_NAMES, executeAccountTool } from './account-tools'
import { BOOKING_TOOLS, executeBookingTool } from './booking-tools'
import { EVENT_TOOLS, EVENT_TOOL_NAMES, executeEventTool } from './event-tools'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
export const AGENT_MODEL = 'claude-sonnet-4-6'

// Prompt caching (CACHE.1): ACCOUNT_TOOLS (~4k tokens) is byte-identical on
// every inbound message and renders BEFORE the per-customer (dynamic) system
// prompt — so the tool block is the one stable, cacheable prefix on this path.
// Marking the LAST tool ephemeral caches the whole tool block (clears the
// 2048-token minimum for claude-sonnet-4-6); the dynamic system + messages
// after it stay uncached. Built once from the shared const so we never mutate
// it. No anthropic-beta header needed — caching is GA on version 2023-06-01.
// AGENT-HANDS.1 — the booking tools join the cached block. Still one
// byte-identical stable prefix; the ephemeral marker moves to the last
// tool of the COMBINED array so the whole block caches.
export const ALL_AGENT_TOOLS = [...ACCOUNT_TOOLS, ...BOOKING_TOOLS, ...EVENT_TOOLS]
const CACHED_ACCOUNT_TOOLS = ALL_AGENT_TOOLS.map((tool, i) =>
  i === ALL_AGENT_TOOLS.length - 1
    ? { ...tool, cache_control: { type: 'ephemeral' } }
    : tool,
)
// Don't re-acknowledge a burst of non-text messages — one soft handoff
// per minute is enough.
const SOFT_NOTIFY_GAP_MS = 60_000
const MAX_HISTORY = 20
export const MAX_TOOL_ITERATIONS = 4

// A claim older than this is treated as stale (e.g. a crashed turn) and
// reclaimable, so a single failed run can't wedge a thread forever.
const STALE_CLAIM_MS = 90_000
// Cost/abuse ceilings (operator-overridable via settings.customer_agent.limits).
const DEFAULT_LIMITS = { convHour: 20, locDay: 500 }

function clampInt(v, fallback, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function resolveLimits(settings) {
  const l = (settings && settings.limits) || {}
  return {
    convHour: clampInt(l.max_replies_per_conversation_per_hour, DEFAULT_LIMITS.convHour, 1, 1000),
    locDay: clampInt(l.max_replies_per_location_per_day, DEFAULT_LIMITS.locDay, 1, 100000),
  }
}

function startOfUtcDayIso() {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}
function hoursAgoIso(h) {
  return new Date(Date.now() - h * 3600_000).toISOString()
}

// Optimistic per-conversation lock via agent_processing_at: claim only if
// it's unset or stale. Concurrent claimers serialise on the row, so exactly
// one wins. Returns true if this caller owns the turn.
async function claimAgentTurn(db, adapter, conversationId) {
  const nowIso = new Date().toISOString()
  const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const { data } = await db.from(adapter.conversationsTable)
    .update({ agent_processing_at: nowIso })
    .eq('id', conversationId)
    .or(`agent_processing_at.is.null,agent_processing_at.lt.${staleIso}`)
    .select('id')
  return Array.isArray(data) && data.length > 0
}

async function releaseAgentTurn(db, adapter, conversationId) {
  try {
    await db.from(adapter.conversationsTable)
      .update({ agent_processing_at: null })
      .eq('id', conversationId)
  } catch { /* best-effort — a stale claim self-expires after STALE_CLAIM_MS */ }
}

// Count agent-sent replies in a window for a cap check. Single-table head
// count, so the PostgREST embedded-resource count bug doesn't apply.
async function countAgentReplies(db, adapter, { field, value, sinceIso }) {
  const { count } = await db.from(adapter.messagesTable)
    .select('id', { count: 'exact', head: true })
    .eq(field, value)
    .eq('source', AGENT_MESSAGE_SOURCE)
    .gte('created_at', sinceIso)
  return count || 0
}

/**
 * Generic per-channel agent turn.
 *
 * Thin wrapper over the real runner purely so every "agent stayed
 * silent" outcome leaves one structured, greppable log line. Skip
 * reasons used to return invisibly — the 2026-06-12 incident took
 * hours to diagnose because nothing said WHY the agent didn't reply.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} adapter  channel adapter (see whatsappAdapter / instagramAdapter)
 * @param {object} ctx
 */
export async function runChannelAgent(db, adapter, ctx) {
  const result = await runChannelAgentInner(db, adapter, ctx)
  if (result?.handled === false) {
    console.warn('[radar-agent] no-reply', JSON.stringify({
      channel: adapter.name,
      conversationId: ctx?.conversationId || null,
      reason: result.reason || 'unknown',
    }))
  }
  return result
}

async function runChannelAgentInner(db, adapter, ctx) {
  const { conversationId, locationId, recipient, contactId, messageType, body, connection } = ctx

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { handled: false, reason: 'no_api_key' }
  if (!conversationId || !locationId) return { handled: false, reason: 'missing_context' }

  const { data: loc } = await db.from('locations')
    .select('name, settings')
    .eq('id', locationId)
    .single()
  const settings = loc?.settings?.customer_agent || null
  const branding = await getLocationBranding(db, locationId)

  // Conversation state: kill switch + linked contact + verification.
  const nameCol = adapter.nameColumn
  const { data: conv } = await db.from(adapter.conversationsTable)
    .select(`agent_active, agent_handed_off_at, contact_id, agent_verified_contact_id, agent_verified_at, agent_last_reply_at${nameCol ? `, ${nameCol}` : ''}`)
    .eq('id', conversationId)
    .single()

  const decision = shouldAgentReply({
    settings,
    conversation: conv,
    message: { type: messageType, body },
    senderPhone: recipient,
    now: new Date(),
  })
  // AGENT-REARM.1 — the cooldown released a handed-off thread: clear the
  // handoff stamp so the inbox queue and future turns agree the agent is
  // back on duty. Best-effort; the decision already treats it as active.
  if (decision.rearm) {
    try {
      await db.from(adapter.conversationsTable)
        .update({ agent_active: true, agent_handed_off_at: null })
        .eq('id', conversationId)
    } catch { /* next turn retries */ }
  }

  if (!decision.reply) {
    // Non-text message while the agent is on duty — acknowledge the
    // customer + flag a human rather than leave them hanging. Doesn't
    // disable the agent; a follow-up text re-engages it.
    if (decision.onDuty && decision.reason === 'unsupported_type') {
      return await softHandoff(db, adapter, { conversationId, locationId, recipient, contactId, connection, settings, lastReplyAt: conv?.agent_last_reply_at })
    }
    return { handled: false, reason: decision.reason }
  }

  // Concurrency claim — stop two near-simultaneous inbound messages from
  // both running a turn on this thread (double reply / double spend /
  // verify race). The loser bails; the winner reads fresh history (which
  // already includes the burst), so nothing is lost.
  const claimed = await claimAgentTurn(db, adapter, conversationId)
  if (!claimed) return { handled: false, reason: 'in_flight' }

  // The agent WILL run a turn now — let the channel show read + typing while
  // Claude thinks. Best-effort; never blocks or fails the turn.
  try { await adapter.onEngage?.(ctx) } catch { /* cosmetic only */ }

  try {
    // Cost / abuse ceilings, cheapest check first. The per-location daily
    // cap stops a runaway across all threads; the per-conversation hourly
    // cap catches a single chatty/looping sender.
    const limits = resolveLimits(settings)
    const locReplies = await countAgentReplies(db, adapter, { field: 'location_id', value: locationId, sinceIso: startOfUtcDayIso() })
    if (locReplies >= limits.locDay) return { handled: false, reason: 'location_daily_cap' }

    const convReplies = await countAgentReplies(db, adapter, { field: 'conversation_id', value: conversationId, sinceIso: hoursAgoIso(1) })
    if (convReplies >= limits.convHour) {
      // Abnormal volume to one person in an hour — loop or abuse. Hand off
      // to a human rather than keep burning the model.
      await handoff(db, adapter, { conversationId, locationId, recipient, contactId, connection, reason: 'rate_limited: hourly agent-reply cap hit', settings })
      return { handled: true, action: 'handoff', reason: 'rate_limited' }
    }

    // AGENT-AUTH.1 + .2 — identity resolution. On a trusted channel (WhatsApp)
    // the SIM-bound sender number pre-verifies the contact. AGENT-AUTH.2 makes
    // that LINK-AWARE: a number on several contacts that are all ONE linked
    // Person (incl. the thread's) verifies and resolves to the group PRIMARY
    // rather than bailing to the email+surname quiz. A number genuinely shared
    // by two different people stays ambiguous → quiz. Instagram has no phone,
    // so its adapter doesn't set trustsSenderIdentity and the question flow
    // stands there — but a still-fresh prior verification is honoured on both
    // channels and ALWAYS resolves to the person's primary account (below).
    let preverifiedContactId = null
    let phoneMatches = null
    if (adapter.trustsSenderIdentity && conv?.contact_id && recipient) {
      const bare = String(recipient).replace(/^\+/, '')
      const { data: matches } = await db.from('contacts')
        .select('id')
        .eq('location_id', locationId)
        .or(`wa_phone.eq.${bare},wa_phone.eq.+${bare},phone.eq.${bare},phone.eq.+${bare}`)
        .limit(20)
      phoneMatches = matches || []
    }

    // Resolve person-group membership + primary for every contact id in play
    // (thread contact, phone matches, any stored verification) in one batch, so
    // linked duplicates collapse to a single identity + the canonical primary.
    const { groupOf, primaryOf } = await personGroupResolver(db, [
      conv?.contact_id,
      conv?.agent_verified_contact_id,
      ...(phoneMatches || []).map((m) => m.id),
    ])

    if (adapter.trustsSenderIdentity && conv?.contact_id && phoneMatches) {
      const verdict = resolveAutoVerify({
        trusted: true,
        conversationContactId: conv.contact_id,
        matches: phoneMatches,
        groupOf,
        primaryOf,
      })
      preverifiedContactId = verdict?.actingContactId || null
      if (preverifiedContactId && conv.agent_verified_contact_id !== preverifiedContactId) {
        await db.from(adapter.conversationsTable).update({
          agent_verified_contact_id: preverifiedContactId,
          agent_verified_at: new Date().toISOString(),
        }).eq('id', conversationId)
      }
    }

    const { data: knowledge } = await db.from('agent_knowledge')
      .select('category, title, content, enabled, sort_order')
      .eq('location_id', locationId)
      .eq('enabled', true)
      .order('sort_order', { ascending: true })

    // Newest rows first then reversed — ascending+limit returns the OLDEST
    // rows, which would freeze the agent's view at the start of the
    // conversation once a thread outgrows the cap (latent amnesia v2).
    const { data: historyDesc } = await db.from(adapter.messagesTable)
      .select('direction, body, message_type, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY * 2)
    const history = (historyDesc || []).slice().reverse()

    // CACHE.2 — content blocks with a cache breakpoint on the location-stable
    // prefix (base prompt + knowledge). Caches cumulatively after the tool
    // block; the volatile suffix (today + identity override) stays uncached.
    const system = buildCachedSystem({
      businessName: branding.companyName,
      locationName: loc?.name || null,
      agentName: settings?.agent_name || null,
      membershipUrl: settings?.membership_signup_url || null,
      tone: settings?.tone || null,
      extraRules: settings?.extra_rules || null,
      knowledge: knowledge || [],
      today: dublinTodayStr(),
      // Tell the model "already verified — don't re-ask" for a phone match OR a
      // still-fresh prior (quiz) verification, so a returning member isn't
      // re-quizzed inside the 30-day window. (Tools already honour the stored
      // verification via toolCtx; this closes the prompt-side gap.)
      identityPreverified: !!preverifiedContactId || isVerificationFresh(conv?.agent_verified_at),
    })

    // EFFORT.1 — operator-tunable reasoning effort (defaults to `medium`, one
    // notch below the API's `high` default) for this short transactional turn.
    const agentEffort = resolveAgentEffort(settings?.effort)

    const messages = formatHistoryForClaude(history || [], { maxMessages: MAX_HISTORY })
    if (messages.length === 0) return { handled: false, reason: 'no_history' }

    // Tool-execution context. verifiedContactId is mutable: verify_identity
    // both stamps the DB and updates this so later tools in the same turn
    // see the verification immediately. channel records which surface a
    // pause/cancel request came from; nameHint lets the email-path identity
    // check accept a surname already shown in the customer's channel name.
    const toolCtx = {
      db,
      conversationId,
      conversationsTable: adapter.conversationsTable,
      contactId: conv?.contact_id || contactId || null,
      // Only honour a prior verification if it's still fresh — a stale one
      // (handle changed hands) forces the customer to re-verify.
      verifiedContactId: preverifiedContactId
        || (isVerificationFresh(conv?.agent_verified_at)
          ? resolveActingContactId({ contactId: conv?.agent_verified_contact_id, groupOf, primaryOf })
          : null),
      locationId,
      channel: adapter.name,
      nameHint: (nameCol && conv?.[nameCol]) || null,
      // AGENT-HANDS.1 — booking tools read the autonomy mode +
      // consultation type from the agent settings blob.
      settings,
    }

    let modelText = ''
    try {
      let iterations = MAX_TOOL_ITERATIONS
      let done = false
      while (iterations-- > 0 && !done) {
        const res = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: AGENT_MODEL,
            max_tokens: 600,
            output_config: { effort: agentEffort },
            system,
            messages,
            tools: CACHED_ACCOUNT_TOOLS,
          }),
        })
        if (!res.ok) {
          console.error('[radar-agent] Anthropic error', res.status, await res.text().catch(() => ''))
          return { handled: false, reason: 'model_error' }
        }
        const data = await res.json()
        const content = data.content || []

        if (data.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content })
          const toolResults = []
          for (const block of content) {
            if (block.type !== 'tool_use') continue
            const result = ACCOUNT_TOOL_NAMES.has(block.name)
              ? await executeAccountTool(block.name, block.input || {}, toolCtx)
              : EVENT_TOOL_NAMES.has(block.name)
                ? await executeEventTool(block.name, block.input || {}, toolCtx)
                : await executeBookingTool(block.name, block.input || {}, toolCtx)
            if (block.name === 'verify_identity' && result?.verified) {
              // Re-read the contact id the server just stamped so the
              // follow-up lookups in this same turn are authorised.
              const { data: fresh } = await db.from(adapter.conversationsTable)
                .select('agent_verified_contact_id')
                .eq('id', conversationId)
                .single()
              const rawVerified = fresh?.agent_verified_contact_id || toolCtx.verifiedContactId
              // AGENT-AUTH.2 — act on the person's PRIMARY account, not whichever
              // duplicate the email+surname quiz happened to match.
              const r = await personGroupResolver(db, [rawVerified])
              toolCtx.verifiedContactId = resolveActingContactId({
                contactId: rawVerified, groupOf: r.groupOf, primaryOf: r.primaryOf,
              }) || rawVerified
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            })
          }
          messages.push({ role: 'user', content: toolResults })
          continue
        }

        // Final turn — collect text.
        modelText = content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        done = true
      }
      if (!done) {
        // Ran out of tool iterations without a final text turn — hand off.
        modelText = ''
      }
    } catch (err) {
      console.error('[radar-agent] model call failed', err?.message)
      return { handled: false, reason: 'model_exception' }
    }

    const parsed = parseAgentResponse(modelText)
    const common = { conversationId, locationId, recipient, contactId, connection }

    if (parsed.action === 'handoff') {
      await handoff(db, adapter, { ...common, reason: parsed.reason, settings })
      return { handled: true, action: 'handoff', reason: parsed.reason }
    }

    const sent = await sendAndLog(db, adapter, { ...common, text: parsed.text, options: parsed.options })
    if (!sent) return { handled: false, reason: 'send_failed' }
    return { handled: true, action: 'reply' }
  } finally {
    await releaseAgentTurn(db, adapter, conversationId)
  }
}

// Send an agent reply + persist it + update the conversation.
// Returns true only when the provider accepted the send — false means
// the customer got NOTHING and the caller must report it (a swallowed
// send failure here returned { handled: true } during the 2026-06-12
// dead-token incident and hid the outage from every surface).
export async function sendAndLog(db, adapter, { conversationId, locationId, recipient, contactId, connection, text, options }) {
  // AGENT-UX.1 — tap choices. Channels with adapter.sendOptions render
  // real buttons; the rest get the choices appended as plain text so the
  // customer always sees them. recordedText is what actually reached the
  // customer (the agent re-reads it as its own history next turn).
  const opts = Array.isArray(options) && options.length >= 2 ? options : null
  let messageId = null
  let recordedText = text
  try {
    if (opts && adapter.sendOptions) {
      const r = await adapter.sendOptions(recipient, text, opts, { locationId, connection })
      messageId = r?.messageId || null
      recordedText = `${text}\n[Options: ${opts.join(' | ')}]`
    } else {
      const sendText = opts ? `${text}\n\n${opts.map(o => `• ${o}`).join('\n')}` : text
      const r = await adapter.send(recipient, sendText, { locationId, connection })
      messageId = r?.messageId || null
      recordedText = sendText
    }
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} send failed`, err?.message)
    return false
  }

  const now = new Date().toISOString()
  await recordAgentMessage(db, adapter,
    adapter.outboundRow({ conversationId, locationId, contactId, messageId, text: recordedText, now })
  )
  await db.from(adapter.conversationsTable).update({
    last_message_at: now,
    last_message_direction: 'outbound',
    last_message_preview: recordedText.substring(0, 100),
    agent_last_reply_at: now,
  }).eq('id', conversationId)
  return true
}

// Persist an agent message row LOUDLY. A rejected insert here is how the
// 2026-06-12 amnesia incident stayed invisible: whatsapp_messages' source
// CHECK constraint refused source='agent', supabase-js returned { error }
// without throwing, and the agent — which rebuilds its view of the
// conversation from this table every turn — never saw its own replies. It
// repeated questions and restarted mid-flow while every send succeeded.
// Mig 259 widened the constraint; this keeps any future persist failure
// out of the silent class.
async function recordAgentMessage(db, adapter, row) {
  const { error } = await db.from(adapter.messagesTable).insert(row)
  if (error) {
    console.error(`[radar-agent] ${adapter.name} failed to record reply (agent history will be incomplete):`, error.message)
  }
}

// Escalate: holding message, stop the agent on this thread, notify staff.
async function handoff(db, adapter, { conversationId, locationId, recipient, contactId, connection, reason, settings }) {
  const holding = (settings?.holding_message || '').trim() || DEFAULT_HOLDING_MESSAGE
  const now = new Date().toISOString()

  await db.from(adapter.conversationsTable).update({
    agent_active: false,
    agent_handed_off_at: now,
  }).eq('id', conversationId)

  try {
    const r = await adapter.send(recipient, holding, { locationId, connection })
    await recordAgentMessage(db, adapter,
      adapter.outboundRow({ conversationId, locationId, contactId, messageId: r?.messageId || null, text: holding, now })
    )
    await db.from(adapter.conversationsTable).update({
      last_message_at: now,
      last_message_direction: 'outbound',
      last_message_preview: holding.substring(0, 100),
    }).eq('id', conversationId)
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} holding-message send failed`, err?.message)
  }

  try {
    await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
      title: `${adapter.label} · needs a human`,
      body: `Agent handed off: ${reason || 'see conversation'}`,
      category: adapter.pushCategory,
      data: { type: adapter.handoffType, conversation_id: conversationId },
    })
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} handoff push failed`, err?.message)
  }
}

// A non-text message the agent can't read (photo / voice / sticker).
// Acknowledge the customer and flag a human, but DON'T disable the agent —
// a follow-up text re-engages it. Debounced via agent_last_reply_at so a
// burst of photos sends one ack, not a string of them.
async function softHandoff(db, adapter, { conversationId, locationId, recipient, contactId, connection, settings, lastReplyAt }) {
  if (lastReplyAt && Date.now() - new Date(lastReplyAt).getTime() < SOFT_NOTIFY_GAP_MS) {
    return { handled: false, reason: 'soft_handoff_debounced' }
  }
  const holding = (settings?.holding_message || '').trim() || DEFAULT_HOLDING_MESSAGE
  const now = new Date().toISOString()
  try {
    const r = await adapter.send(recipient, holding, { locationId, connection })
    await recordAgentMessage(db, adapter,
      adapter.outboundRow({ conversationId, locationId, contactId, messageId: r?.messageId || null, text: holding, now })
    )
    await db.from(adapter.conversationsTable).update({
      last_message_at: now,
      last_message_direction: 'outbound',
      last_message_preview: holding.substring(0, 100),
      agent_last_reply_at: now,
    }).eq('id', conversationId)
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} soft-handoff send failed`, err?.message)
  }
  try {
    await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
      title: `${adapter.label} · non-text message`,
      body: "Customer sent a photo / voice / attachment the agent can't read — needs a human.",
      category: adapter.pushCategory,
      data: { type: adapter.handoffType, conversation_id: conversationId },
    })
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} soft-handoff push failed`, err?.message)
  }
  return { handled: true, action: 'soft_handoff', reason: 'unsupported_type' }
}

// ── WhatsApp adapter ────────────────────────────────────────────────
export const whatsappAdapter = {
  name: 'whatsapp',
  label: 'WhatsApp',
  conversationsTable: 'whatsapp_conversations',
  messagesTable: 'whatsapp_messages',
  nameColumn: 'wa_profile_name',
  pushCategory: 'whatsapp',
  handoffType: 'whatsapp_agent_handoff',
  // Meta authenticates the sender's phone number — safe to use as identity.
  trustsSenderIdentity: true,
  // Fires once the agent has committed to replying (gating + claim passed):
  // marks the inbound read and shows "typing…" while Claude composes.
  onEngage: async ({ waMessageId, locationId }) => {
    if (!waMessageId) return
    try { await sendTypingIndicator(waMessageId, { locationId }) }
    catch (e) { console.warn('[agent] typing indicator failed:', e?.message) }
  },
  send: (recipient, text, { locationId }) => sendTextMessage(recipient, text, { locationId }),
  sendOptions: (recipient, text, options, { locationId }) => sendInteractiveOptions(recipient, text, options, { locationId }),
  outboundRow: ({ conversationId, locationId, contactId, messageId, text, now }) => ({
    conversation_id: conversationId,
    contact_id: contactId || null,
    location_id: locationId,
    wa_message_id: messageId,
    direction: 'outbound',
    message_type: 'text',
    body: text,
    status: 'sent',
    source: AGENT_MESSAGE_SOURCE,
    sent_at: now,
  }),
}

/**
 * WhatsApp entry point — unchanged signature, called from the WA webhook.
 * Delegates to the shared runner via the WhatsApp adapter.
 */
export async function maybeAutoReply(db, ctx) {
  return runChannelAgent(db, whatsappAdapter, {
    conversationId: ctx.conversationId,
    locationId: ctx.locationId,
    recipient: ctx.senderPhone,
    contactId: ctx.contactId,
    messageType: ctx.messageType,
    body: ctx.body,
    // Inbound wamid — lets onEngage mark-read + show typing while Claude thinks.
    waMessageId: ctx.waMessageId || null,
  })
}
