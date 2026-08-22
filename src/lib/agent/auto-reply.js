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

import { sendTextMessage, sendInteractiveOptions, sendTypingIndicator, sendCtaUrlMessage, splitTrailingUrl } from '@/lib/whatsapp'
import { recordAgentDecision, compactDecisionMeta } from './decision-log'
import { dublinTodayStr } from '@/lib/dublin-time'
import { sendPushToRolesAtLocation, sendPushToInboxStaffAtLocation } from '@/lib/push'
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
  distinctPersonCount,
  shouldNotifyAgentActivity,
  resolveVerifyFailHandoff,
  shouldHandoffAfterVerifyFail,
  nextVerifyAttempts,
  warnLiveDespiteTestMode,
} from './core'
import { personGroupResolver } from '@/lib/person-links'
import { ACCOUNT_TOOLS, ACCOUNT_TOOL_NAMES, executeAccountTool } from './account-tools'
import { BOOKING_TOOLS, executeBookingTool } from './booking-tools'
import { EVENT_TOOLS, EVENT_TOOL_NAMES, executeEventTool } from './event-tools'
import { CARD_TOOLS, CARD_TOOL_NAMES, executeCardTool } from './card-tools'
import { anthropicMessages } from '@/lib/anthropic'
// MIA-HYGIENE.4 — the agent's own caught failures never reached error_events
// (mig 435 only ever saw errors that escaped Next), so Vercel log retention
// was the entire forensic window for a Mia outage.
import { recordErrorEvent } from '@/lib/error-events'
import { getAiCapStatus } from '@/lib/usage-caps'
import { checkSpend } from '@/lib/wallet-enforcement'

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
export const ALL_AGENT_TOOLS = [...ACCOUNT_TOOLS, ...BOOKING_TOOLS, ...EVENT_TOOLS, ...CARD_TOOLS]
// MIA-HYGIENE.5 — 1h TTL on this cross-turn breakpoint (see prompt.js
// buildCachedSystem for the measurement). The intra-turn tool_result marker
// further down keeps the 5-minute default: it caches a prefix that only lives
// for the rest of the turn, so the 1h write premium would buy nothing.
// Exported so the eval harness sends the EXACT block production sends. It used
// to rebuild its own copy "in the same shape", which silently drifted the
// moment the TTL changed here and cost a full eval run to a 400.
export const CACHED_ACCOUNT_TOOLS = ALL_AGENT_TOOLS.map((tool, i) =>
  i === ALL_AGENT_TOOLS.length - 1
    ? { ...tool, cache_control: { type: 'ephemeral', ttl: '1h' } }
    : tool,
)
// Don't re-acknowledge a burst of non-text messages — one soft handoff
// per minute is enough.
const SOFT_NOTIFY_GAP_MS = 60_000
const MAX_HISTORY = 20
// 6, not 4: a real booking turn can legitimately chain verify → list →
// book → re-list (slot taken) and still owe the customer a text reply;
// at 4 the turn ran dry mid-flow and fell through to a handoff.
export const MAX_TOOL_ITERATIONS = 6
// After a reply, one bounded re-run picks up inbound messages that arrived
// while the turn was in flight (the concurrency claim makes the second
// webhook bail with in_flight — without this, that message is never
// answered; a live customer tapped "Different time" 4s after "Yes — book
// me in" and got silence, 2026-06-14).
const MAX_MISSED_INBOUND_RERUNS = 2

// A claim older than this is treated as stale (e.g. a CRASHED turn) and
// reclaimable, so a single failed run can't wedge a thread forever. It is a
// crash-recovery threshold, NOT a turn budget: a live turn heartbeats the
// claim between model calls (heartbeatAgentTurn), so a slow-but-alive turn is
// never reclaimed and two runners can never generate on one thread.
const STALE_CLAIM_MS = 90_000
// Per-API-call abort. Without it a hung fetch (undici's defaults are minutes)
// could outlive both the claim and Meta's webhook timeout.
const MODEL_TIMEOUT_MS = 60_000
// Initial attempt + 2 retries. 429/5xx/network blips are routine and
// self-heal in seconds; escalating on the first one costs the customer their
// answer and pages a manager for nothing.
const MODEL_MAX_ATTEMPTS = 3
const MODEL_RETRY_BASE_MS = 250
const MODEL_RETRY_AFTER_CAP_MS = 5_000
// max_tokens for the reply. 600 is right for the "a sentence or two" house
// style; a truncated turn retries once at the raised cap before handing off
// rather than sending a cut-off (possibly sentinel-splitting) reply.
const MODEL_MAX_TOKENS = 600
const MODEL_MAX_TOKENS_RETRY = 1000
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
// one wins. Returns the stamp this caller wrote (its claim token) or null.
async function claimAgentTurn(db, adapter, conversationId) {
  const nowIso = new Date().toISOString()
  const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const { data } = await db.from(adapter.conversationsTable)
    .update({ agent_processing_at: nowIso })
    .eq('id', conversationId)
    .or(`agent_processing_at.is.null,agent_processing_at.lt.${staleIso}`)
    .select('id')
  return Array.isArray(data) && data.length > 0 ? nowIso : null
}

// Re-stamp the claim mid-turn so a long-but-live turn never reads as stale.
// Compare-and-set on our own stamp: null means another runner owns the thread
// now (only reachable if a single call ever outlasts STALE_CLAIM_MS) and this
// turn must stand down. A DB blip keeps the existing stamp — a transient read
// failure must not abandon a turn that is otherwise fine.
async function heartbeatAgentTurn(db, adapter, conversationId, claimStamp) {
  if (!claimStamp) return null
  const nowIso = new Date().toISOString()
  try {
    const { data } = await db.from(adapter.conversationsTable)
      .update({ agent_processing_at: nowIso })
      .eq('id', conversationId)
      .eq('agent_processing_at', claimStamp)
      .select('id')
    return Array.isArray(data) && data.length > 0 ? nowIso : null
  } catch {
    return claimStamp
  }
}

// Compare-and-clear: only release the claim while it is still OURS. An
// unconditional clear let a turn that had been reclaimed as stale wipe the
// reclaimer's claim in its finally block, opening the thread to a third
// concurrent runner.
async function releaseAgentTurn(db, adapter, conversationId, claimStamp) {
  try {
    let q = db.from(adapter.conversationsTable)
      .update({ agent_processing_at: null })
      .eq('id', conversationId)
    if (claimStamp) q = q.eq('agent_processing_at', claimStamp)
    await q
  } catch { /* best-effort — a stale claim self-expires after STALE_CLAIM_MS */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 429 and 5xx are transient (rate-limit / overloaded / gateway); every other
// 4xx is a request the retry would re-send unchanged.
function isRetryableStatus(status) {
  return status === 429 || status >= 500
}

function retryAfterMs(res) {
  const raw = res?.headers?.get?.('retry-after')
  if (!raw) return null
  const secs = Number(raw)
  if (!Number.isFinite(secs) || secs <= 0) return null
  return Math.min(secs * 1000, MODEL_RETRY_AFTER_CAP_MS)
}

// Exponential with jitter, so a shared outage doesn't resynchronise every
// in-flight turn onto the same retry instant.
function backoffMs(attempt) {
  return MODEL_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * MODEL_RETRY_BASE_MS)
}

/**
 * One metered Anthropic call with a per-attempt abort timeout and bounded
 * retries on transient failures. Returns the same { res, data } shape as
 * anthropicMessages (the caller keeps its !res.ok branch) plus
 * { aborted: true } when `beforeAttempt` says the claim was lost. A thrown
 * fetch (network / abort) is retried too and only rethrown on the last
 * attempt, so the caller's model_exception path still catches it.
 */
async function callAgentModel(body, meta, { beforeAttempt } = {}) {
  for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt++) {
    if (beforeAttempt && (await beforeAttempt()) === false) return { aborted: true }
    try {
      const { res, data } = await anthropicMessages(body, {
        ...meta,
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      })
      if (res.ok || attempt === MODEL_MAX_ATTEMPTS || !isRetryableStatus(res.status)) {
        return { res, data }
      }
      const detail = await res.text().catch(() => '')
      console.warn('[radar-agent] Anthropic transient error, retrying', JSON.stringify({
        status: res.status, attempt, detail: detail.slice(0, 200),
      }))
      await sleep(retryAfterMs(res) ?? backoffMs(attempt))
    } catch (err) {
      if (attempt === MODEL_MAX_ATTEMPTS) throw err
      console.warn('[radar-agent] Anthropic call threw, retrying', JSON.stringify({
        attempt, message: err?.message || String(err),
      }))
      await sleep(backoffMs(attempt))
    }
  }
  // Unreachable — the loop always returns or throws on the last attempt.
  return { res: null, data: null }
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
  // MIA-REVIEW.3 — the turn fills this in so the decision row can name the
  // account Mia actually ACTED AS (the person-group primary after a phone
  // match or the email quiz), not just the contact the thread is bound to.
  // Mig 444: tools/stopReason/iterations land in agent_decisions.meta
  // (compacted by compactDecisionMeta) so a decision row can also say WHAT
  // the turn did, not just whether it replied. A rerun keeps appending to
  // the same trace — the row describes the whole customer-visible exchange.
  const trace = { actingContactId: null, tools: [], stopReason: null, iterations: 0 }
  let result = await runChannelAgentInner(db, adapter, ctx, trace)

  // Missed-inbound sweep: if the customer sent more while we were composing
  // (their webhook lost the concurrency claim and bailed), run another turn
  // so that message gets answered. Bounded; each re-run reads fresh history.
  let reruns = 0
  while (
    reruns < MAX_MISSED_INBOUND_RERUNS &&
    result?.handled === true && result.action === 'reply' && result.lastInboundSeenIso
  ) {
    const missed = await hasInboundAfter(db, adapter, ctx?.conversationId, result.lastInboundSeenIso)
    if (!missed) break
    reruns++
    console.warn('[radar-agent] missed-inbound rerun', JSON.stringify({
      channel: adapter.name, conversationId: ctx?.conversationId || null, rerun: reruns,
    }))
    result = await runChannelAgentInner(db, adapter, ctx, trace)
  }

  if (result?.handled === false) {
    console.warn('[radar-agent] no-reply', JSON.stringify({
      channel: adapter.name,
      conversationId: ctx?.conversationId || null,
      reason: result.reason || 'unknown',
    }))
  }

  // FEAT-AGENT-TRACE.1 — persist WHY (reply vs silent + reason) so the inbox
  // decision-trace can show it. Best-effort; never affects the turn.
  await recordAgentDecision(db, {
    channel: adapter.name,
    conversationId: ctx?.conversationId,
    // The acting (verified) account when the turn resolved one — that is the
    // contact whose data the read tools disclosed. Falls back to the thread's
    // contact for turns that never verified.
    contactId: trace.actingContactId || ctx?.contactId,
    locationId: ctx?.locationId,
    decision: result?.handled === true && result?.action === 'reply' ? 'reply' : 'silent',
    reason: result?.reason,
    meta: compactDecisionMeta(trace),
  })

  return result
}

// Any inbound row newer than the last one the just-finished turn saw?
async function hasInboundAfter(db, adapter, conversationId, sinceIso) {
  if (!conversationId || !sinceIso) return false
  const { data } = await db.from(adapter.messagesTable)
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .gt('created_at', sinceIso)
    .limit(1)
  return Array.isArray(data) && data.length > 0
}

// AGENT-REARM.3 — did a human take this thread over since the turn began?
// Two signals: (1) the conversation's agent gate was flipped off (the inbox
// human-send route stamps a manual take-over), or (2) a HUMAN outbound landed
// after turn start (a staff reply mid-generation, before the gate flip
// committed). Either means Mia must stay quiet.
//
// MIA-HYGIENE.3 — this guard FAILS CLOSED: if it cannot establish that the
// thread is still Mia's, it reports a takeover and the reply is dropped. It
// used to return false on any failure, which aimed the uncertainty squarely at
// the outcome the guard exists to prevent. The failure modes are not
// symmetric: a dropped agent reply is recoverable (the handoff cooldown
// re-arms her, and the missed-inbound sweep re-runs the turn), while a second
// message landing on top of a human's is not, and it breaks the standing rule
// that a human-led thread belongs to the human. Richard, 2026-08-20.
//
// Note the supabase-js shape trap this also closes: a failed query RESOLVES as
// { data: null, error } instead of throwing, so a catch-only guard never saw a
// read failure at all — it was indistinguishable from "nobody took over".
export async function humanTookOverDuringTurn(db, adapter, conversationId, sinceIso) {
  if (!conversationId) return false
  try {
    // INBOX-REDESIGN.2.3 — agent_paused_at (mig 435) is a WhatsApp-only
    // column (instagram_conversations has no such column), so it's only
    // added to the select for the WhatsApp adapter — same guard as the
    // conv-select in runChannelAgentInner below and the adapter.name ===
    // 'whatsapp' branch already used for wa_card_sets further down this file.
    const isWhatsApp = adapter.name === 'whatsapp'
    const { data: conv, error: convError } = await db.from(adapter.conversationsTable)
      .select(isWhatsApp ? 'agent_active, agent_paused_at' : 'agent_active')
      .eq('id', conversationId)
      .single()
    if (convError) return takeoverCheckFailed(adapter, conversationId, 'conversation_read', convError)
    // A sticky pause mid-turn is also a takeover: Mia must not talk over an
    // operator who just paused the thread while she was generating.
    if (conv && (conv.agent_active === false || conv.agent_paused_at)) return true

    const { data: lastOut, error: lastOutError } = await db.from(adapter.messagesTable)
      .select(`${adapter.humanOutboundColumns || 'source'}, created_at`)
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .limit(1)
    if (lastOutError) return takeoverCheckFailed(adapter, conversationId, 'last_outbound_read', lastOutError)
    const row = Array.isArray(lastOut) ? lastOut[0] : null
    if (!row || !adapter.isHumanOutbound?.(row)) return false
    // Only a human message from THIS turn counts — an old human message with a
    // since-cooldown re-arm must not suppress the legitimately re-armed reply.
    return !sinceIso || !row.created_at || row.created_at >= sinceIso
  } catch (err) {
    return takeoverCheckFailed(adapter, conversationId, 'exception', err)
  }
}

// Log the drop loudly and report a takeover. A silently-dropped reply is the
// kind of thing that reads as "Mia ignored me" weeks later with nothing in the
// logs to explain it, so every fail-closed drop names its stage.
function takeoverCheckFailed(adapter, conversationId, stage, err) {
  console.warn('[radar-agent] takeover check failed — dropping reply', JSON.stringify({
    channel: adapter?.name || null,
    conversationId: conversationId || null,
    stage,
    error: String(err?.message || err || '').slice(0, 160),
  }))
  return true
}

async function runChannelAgentInner(db, adapter, ctx, trace = {}) {
  const { conversationId, locationId, recipient, contactId, messageType, body, connection } = ctx

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { handled: false, reason: 'no_api_key' }
  if (!conversationId || !locationId) return { handled: false, reason: 'missing_context' }

  const { data: loc } = await db.from('locations')
    .select('name, settings')
    .eq('id', locationId)
    .single()
  const settings = loc?.settings?.customer_agent || null
  // Tripwire only — enabled+test_mode being live for everyone is the
  // documented invariant, not a bug. Logged once per process per location so
  // the half-configured state is greppable when an operator is surprised by it.
  warnLiveDespiteTestMode(locationId, settings)
  const branding = await getLocationBranding(db, locationId)

  // Conversation state: kill switch + linked contact + verification.
  const nameCol = adapter.nameColumn
  // INBOX-REDESIGN.2.3 — agent_paused_at (mig 435) is a WhatsApp-only column;
  // instagram_conversations has no such column, so (like nameCol above) it's
  // only appended to the select for the WhatsApp adapter. Selecting it
  // unconditionally would 400 the whole conv fetch for every Instagram turn.
  const isWhatsApp = adapter.name === 'whatsapp'
  const { data: conv } = await db.from(adapter.conversationsTable)
    .select(`agent_active, agent_handed_off_at, contact_id, agent_verified_contact_id, agent_verified_at, agent_last_reply_at, agent_activity_notified_at, agent_verify_attempts${nameCol ? `, ${nameCol}` : ''}${isWhatsApp ? ', agent_paused_at' : ''}`)
    .eq('id', conversationId)
    .single()

  // AGENT-REARM.2 — a potential re-arm (agent off) must know who sent the
  // thread's last outbound message: if it was a HUMAN, the customer is
  // replying to them and the agent must stay out regardless of cooldown.
  // Only queried when the agent is actually off, so the hot path pays nothing.
  let lastOutboundHuman = false
  if (conv?.agent_active === false) {
    const { data: lastOut } = await db.from(adapter.messagesTable)
      .select(adapter.humanOutboundColumns || 'source')
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .limit(1)
    const row = Array.isArray(lastOut) ? lastOut[0] : null
    lastOutboundHuman = !!(row && adapter.isHumanOutbound?.(row))
  }

  const decision = shouldAgentReply({
    settings,
    conversation: conv,
    message: { type: messageType, body },
    senderPhone: recipient,
    lastOutboundHuman,
    now: new Date(),
  })
  // AGENT-REARM.1 — the cooldown released a handed-off thread: clear the
  // handoff stamp so the inbox queue and future turns agree the agent is
  // back on duty. Best-effort; the decision already treats it as active.
  if (decision.rearm) {
    try {
      await db.from(adapter.conversationsTable)
        // MIA-REVIEW.3 — handoff_escalated_at clears with the handoff stamp,
        // or the SLA sweep could only ever escalate this thread once, ever.
        .update({ agent_active: true, agent_handed_off_at: null, agent_verify_attempts: 0, handoff_escalated_at: null })
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

  // SAAS4-M2 — optional per-org HARD AI-spend cap (Richard 2026-07-19:
  // overage billing is the default soft band; only an operator-set hard
  // cap interrupts service). At cap: soft-handoff — holding message +
  // manager push, debounced, agent stays armed so raising the cap
  // re-engages it on the next inbound. Fails OPEN inside the helper.
  const aiCap = await getAiCapStatus({ locationId })
  if (aiCap.capped) {
    return await softHandoff(db, adapter, {
      conversationId, locationId, recipient, contactId, connection, settings,
      lastReplyAt: conv?.agent_last_reply_at,
      reason: 'ai_cap',
      notify: {
        title: `${adapter.label} · agent paused (AI cap)`,
        body: `The org's monthly AI hard cap is reached (est. $${(aiCap.spendCents / 100).toFixed(2)} of $${(aiCap.capCents / 100).toFixed(2)}). The customer got the holding message — needs a human. Raise or clear the cap to resume Mia.`,
      },
    })
  }

  // INTEG-C3 — per-LOCATION prepaid wallet gate, beside (composing
  // with, never replacing) the per-ORG hard cap above: a tier-pinned
  // location whose monthly AI allowance is used up AND whose wallet is
  // empty soft-pauses Mia. Same shape as ai_cap — the check runs at
  // turn-START, so a turn already in flight always FINISHES its reply
  // before the next inbound hits this pause; softHandoff keeps the
  // agent armed (a top-up re-engages it on the next inbound) and its
  // debounce keeps a message burst to ONE holding message. Unpinned
  // locations answer 'unpinned' → byte-identical old behaviour.
  // Fail-open on any error (checkSpend never throws; belt-and-braces).
  try {
    const walletSpend = await checkSpend(db, locationId, 'ai_message', 'ai')
    if (!walletSpend.allow) {
      return await softHandoff(db, adapter, {
        conversationId, locationId, recipient, contactId, connection, settings,
        lastReplyAt: conv?.agent_last_reply_at,
        reason: 'wallet_empty',
        notify: {
          title: `${adapter.label} · agent paused (wallet empty)`,
          body: 'The location\'s monthly AI allowance is used up and the prepaid wallet is empty. The customer got the holding message — needs a human. Top up the wallet to resume Mia.',
        },
      })
    }
  } catch { /* fail open — never let billing silence Mia */ }

  // Concurrency claim — stop two near-simultaneous inbound messages from
  // both running a turn on this thread (double reply / double spend /
  // verify race). The loser bails; the winner reads fresh history (which
  // already includes the burst), so nothing is lost.
  let claimStamp = await claimAgentTurn(db, adapter, conversationId)
  if (!claimStamp) return { handled: false, reason: 'in_flight' }
  // AGENT-REARM.3 — remember when this turn began so we can tell, just before
  // sending, whether a human took the thread over WHILE the model was thinking.
  const turnStartIso = new Date().toISOString()

  // The agent WILL run a turn now — let the channel show read + typing while
  // Claude thinks. Best-effort; never blocks or fails the turn.
  try { await adapter.onEngage?.(ctx) } catch { /* cosmetic only */ }

  try {
    // Cost / abuse ceilings, cheapest check first. The per-location daily
    // cap stops a runaway across all threads; the per-conversation hourly
    // cap catches a single chatty/looping sender.
    const limits = resolveLimits(settings)
    const locReplies = await countAgentReplies(db, adapter, { field: 'location_id', value: locationId, sinceIso: startOfUtcDayIso() })
    if (locReplies >= limits.locDay) {
      // Dead air the customer can't see: no holding message (the cap is a
      // cost ceiling, not an escalation) and Mia stays silent for EVERY
      // thread at this location until UTC midnight. Page managers once a day
      // so the cap can be raised instead of the silence going unnoticed.
      await notifyDeadAir(db, adapter, {
        locationId, conversationId, reason: 'location_daily_cap',
        sinceIso: startOfUtcDayIso(),
        title: `${adapter.label} · agent paused (daily cap)`,
        body: `Mia has hit this location's daily reply cap (${limits.locDay}) and is silent until midnight UTC. Customers are not being answered — raise the cap in Settings → Customer agent, or reply manually.`,
      })
      return { handled: false, reason: 'location_daily_cap' }
    }

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

    // AGENT-AUTH.3 — a number linked to more than one PERSON can't be
    // auto-identified (one ungrouped duplicate is enough to trip it, and we
    // can't always dedupe). Tell the prompt so Mia asks WHICH account (by email)
    // with context instead of the blind email+surname quiz. Duplicate rows
    // already linked as one Person collapse to a single person and don't trip
    // this. The prompt only acts on it when the sender isn't already verified.
    const multipleAccounts = distinctPersonCount(phoneMatches, groupOf) >= 2

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
    // Newest inbound this turn will have seen — the wrapper's missed-inbound
    // sweep compares against it after the reply goes out.
    const lastInboundSeenIso = (historyDesc || []).find((m) => m.direction === 'inbound')?.created_at || null

    // Acting contact for this turn (a phone/link-preverified id, else a
    // still-fresh prior verification). Resolved once and reused for both the
    // prompt's known-contact awareness and the tool context so they agree.
    const resolvedVerifiedContactId = preverifiedContactId
      || (isVerificationFresh(conv?.agent_verified_at)
        ? resolveActingContactId({ contactId: conv?.agent_verified_contact_id, groupOf, primaryOf })
        : null)

    // Known-contact awareness — if the linked contact already has a name/email
    // on file, tell the prompt so Mia never re-asks for them (Edel Crehan,
    // 2026-07-06). Best-effort; a missing contact just omits the block.
    let knownContact = null
    const promptContactId = resolvedVerifiedContactId || conv?.contact_id || contactId || null
    if (promptContactId) {
      const { data: kc } = await db.from('contacts')
        .select('first_name, email')
        .eq('id', promptContactId)
        .maybeSingle()
      if (kc) {
        knownContact = {
          firstName: String(kc.first_name || '').trim() || null,
          hasEmail: !!String(kc.email || '').trim(),
        }
      }
    }

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
      // MIA-CARDS.1 — card sets are WhatsApp-only (Instagram has no carousel
      // surface), so only the WhatsApp prompt lists them. Lives on the raw
      // location settings blob, NOT settings.customer_agent — the inbox
      // composer shares the same sets.
      cardSets: adapter.name === 'whatsapp' ? (loc?.settings?.wa_card_sets || []) : [],
      today: dublinTodayStr(),
      // Tell the model "already verified — don't re-ask" for a phone match OR a
      // still-fresh prior (quiz) verification, so a returning member isn't
      // re-quizzed inside the 30-day window. (Tools already honour the stored
      // verification via toolCtx; this closes the prompt-side gap.)
      identityPreverified: !!preverifiedContactId || isVerificationFresh(conv?.agent_verified_at),
      // AGENT-AUTH.3 — number linked to >1 person → ask which account by email.
      multipleAccounts,
      knownContact,
    })

    // EFFORT.1 — operator-tunable reasoning effort (defaults to `medium`, one
    // notch below the API's `high` default) for this short transactional turn.
    const agentEffort = resolveAgentEffort(settings?.effort)
    const verifyFailThreshold = resolveVerifyFailHandoff(settings)

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
      verifiedContactId: resolvedVerifiedContactId,
      locationId,
      channel: adapter.name,
      nameHint: (nameCol && conv?.[nameCol]) || null,
      // AGENT-HANDS.1 — booking tools read the autonomy mode +
      // consultation type from the agent settings blob.
      settings,
    }
    // MIA-REVIEW.3 — surface the acting account to the decision log.
    trace.actingContactId = toolCtx.verifiedContactId || null

    let verifyFails = conv?.agent_verify_attempts ?? 0
    let modelText = ''
    // A stop_reason / tool outcome that must NOT become a customer reply.
    // Set inside the loop, actioned as a soft handoff just after it.
    let stopFailure = null
    try {
      let iterations = MAX_TOOL_ITERATIONS
      let done = false
      let claimLost = false
      let maxTokens = MODEL_MAX_TOKENS
      let raisedTokenCap = false
      // The tool_result block currently carrying the intra-turn cache
      // breakpoint — moved forward each iteration so we stay inside the
      // 4-breakpoint cap (the tool block + stable system block hold two).
      let cachedToolResult = null
      // Per-tool throw counter: one bad call is recoverable, the same tool
      // failing twice in a turn is not.
      const toolThrows = new Map()
      while (iterations-- > 0 && !done) {
        // SAAS4-M1 — metered via the shared wrapper (source: mia_auto_reply);
        // each tool-loop iteration is one API call and one usage event.
        const { res, data, aborted } = await callAgentModel(
          {
            model: AGENT_MODEL,
            max_tokens: maxTokens,
            output_config: { effort: agentEffort },
            system,
            messages,
            tools: CACHED_ACCOUNT_TOOLS,
          },
          { apiKey, locationId, source: 'mia_auto_reply' },
          {
            // Heartbeat before every attempt (not just every iteration) so a
            // retry chain can't drift past STALE_CLAIM_MS either.
            beforeAttempt: async () => {
              const beat = await heartbeatAgentTurn(db, adapter, conversationId, claimStamp)
              if (!beat) return false
              claimStamp = beat
              return true
            },
          },
        )
        if (aborted) { claimLost = true; break }
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          console.error('[radar-agent] Anthropic error', res.status, errBody)
          await noteModelFailure(trace, adapter, {
            kind: 'model_error',
            status: res.status,
            attempts: MODEL_MAX_ATTEMPTS,
            message: errBody || `HTTP ${res.status}`,
            conversationId,
          })
          // COMMS-AUDIT 2026-07-10 — a model outage must not mean dead air:
          // send the holding message + page managers via the soft-handoff
          // path (its agent_last_reply_at debounce keeps webhook retries /
          // message bursts to ONE holding message). The agent stays armed,
          // so it resumes as soon as the API recovers.
          return await softHandoff(db, adapter, {
            conversationId, locationId, recipient, contactId, connection, settings,
            lastReplyAt: conv?.agent_last_reply_at,
            reason: 'model_error',
            notify: modelFailureNotify(adapter),
          })
        }
        const content = data.content || []
        // Mig 444 — decision-log trace: last stop_reason wins (it's the one
        // that ended the turn); iterations count actual API responses.
        trace.stopReason = data.stop_reason || null
        trace.iterations += 1

        if (data.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content })
          const toolResults = []
          let toolFailed = null
          for (const block of content) {
            if (block.type !== 'tool_use') continue
            // Mig 444 — record the call before executing so even a thrown
            // executor leaves its footprint in the decision trace.
            trace.tools.push({ name: block.name, input: block.input || {} })
            // A THROWN executor (dynamic-import failure, an unexpected
            // TypeError) used to abort the turn through the outer catch and
            // page managers with "model API failure" copy while Anthropic was
            // fine. Hand the failure back to the model as an is_error
            // tool_result instead, so it can retry or hand off in its own
            // words; ops keep the real signal in the log line.
            let result
            try {
              result = ACCOUNT_TOOL_NAMES.has(block.name)
                ? await executeAccountTool(block.name, block.input || {}, toolCtx)
                : EVENT_TOOL_NAMES.has(block.name)
                  ? await executeEventTool(block.name, block.input || {}, toolCtx)
                  : CARD_TOOL_NAMES.has(block.name)
                    ? await executeCardTool(block.name, block.input || {}, toolCtx)
                    : await executeBookingTool(block.name, block.input || {}, toolCtx)
            } catch (err) {
              const throws = (toolThrows.get(block.name) || 0) + 1
              toolThrows.set(block.name, throws)
              console.error('[radar-agent] tool threw', JSON.stringify({
                tool: block.name, throws, message: err?.message || String(err),
              }))
              if (throws >= 2) { toolFailed = block.name; break }
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: 'tool_failed', message: 'That lookup failed unexpectedly. Try once more or hand off to the team.' }),
                is_error: true,
              })
              continue
            }
            if (block.name === 'verify_identity') {
              // AGENT-VERIFY-HANDOFF.1 — track consecutive failures so a stuck
              // quiz hands off (reset on success, +1 on failure).
              verifyFails = nextVerifyAttempts(verifyFails, result)
              if (result?.verified) {
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
                trace.actingContactId = toolCtx.verifiedContactId
              }
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result),
            })
          }
          if (toolFailed) { stopFailure = 'tool_error'; break }
          // CACHE.3 — tool results (timetables, account payloads) are the
          // bulkiest part of the request and every iteration re-sends all of
          // them. A breakpoint on the newest one lets the next iteration read
          // the whole accumulated prefix from cache; the marker moves rather
          // than accumulating so the 4-breakpoint cap holds.
          if (toolResults.length) {
            if (cachedToolResult) delete cachedToolResult.cache_control
            cachedToolResult = toolResults[toolResults.length - 1]
            cachedToolResult.cache_control = { type: 'ephemeral' }
          }
          messages.push({ role: 'user', content: toolResults })
          continue
        }

        // The model declined. Any partial text it emitted is part of the
        // refusal, not an answer — discard it and hand off under its own
        // reason so the decision trace names the real cause.
        if (data.stop_reason === 'refusal') {
          stopFailure = 'model_refusal'
          break
        }

        // Truncated mid-reply. Never send it: the cut can land inside a
        // trailing [[OPTIONS]]/[[HANDOFF]] sentinel and leak the fragment.
        // One retry at a raised cap, then hand off.
        if (data.stop_reason === 'max_tokens') {
          if (!raisedTokenCap) {
            raisedTokenCap = true
            maxTokens = MODEL_MAX_TOKENS_RETRY
            continue
          }
          stopFailure = 'model_truncated'
          break
        }

        // NOTE: 'pause_turn' cannot occur today (no server-side tools in
        // CACHED_ACCOUNT_TOOLS). Adding one requires handling it here —
        // it would otherwise fall through as an empty final turn.
        // Final turn — collect text.
        modelText = content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        done = true
      }
      if (claimLost) return { handled: false, reason: 'claim_lost' }
      if (!done && !stopFailure) {
        // Ran out of tool iterations without a final text turn — hand off.
        modelText = ''
      }
    } catch (err) {
      console.error('[radar-agent] model call failed', err?.message)
      await noteModelFailure(trace, adapter, {
        kind: 'model_exception',
        message: err?.message || String(err),
        conversationId,
      })
      // Same soft handoff as the non-2xx path above — holding message once
      // (debounced) + manager push, agent stays armed for when the model
      // comes back.
      return await softHandoff(db, adapter, {
        conversationId, locationId, recipient, contactId, connection, settings,
        lastReplyAt: conv?.agent_last_reply_at,
        reason: 'model_exception',
        notify: modelFailureNotify(adapter),
      })
    }

    // A refusal / twice-truncated / twice-throwing-tool turn owes the customer
    // an acknowledgement but must not send what the model produced. Same
    // soft-handoff floor as a model outage, but under a reason of its own so
    // staff and the decision trace can tell the three apart.
    if (stopFailure) {
      console.warn('[radar-agent] turn abandoned', JSON.stringify({
        channel: adapter.name, conversationId, reason: stopFailure,
      }))
      // A refusal or a twice-truncated turn is a model failure too — the
      // customer got a holding message instead of an answer, so it belongs in
      // the trace and in error_events alongside outages.
      await noteModelFailure(trace, adapter, {
        kind: stopFailure,
        message: `stop_reason=${trace.stopReason || 'unknown'}`,
        conversationId,
      })
      return await softHandoff(db, adapter, {
        conversationId, locationId, recipient, contactId, connection, settings,
        lastReplyAt: conv?.agent_last_reply_at,
        reason: stopFailure,
        notify: abandonedTurnNotify(adapter, stopFailure),
      })
    }

    const parsed = parseAgentResponse(modelText)
    const common = { conversationId, locationId, recipient, contactId, connection }

    // AGENT-REARM.3 — a human may have TAKEN OVER while the model was
    // generating (Aisling Fagan 2026-07-13: Garrett's inbox takeover and Mia's
    // reply left in the same second, so the customer saw two contradictory
    // UN1T messages). The turn's gating ran seconds earlier, before the
    // takeover landed. Re-check the live takeover state now and drop Mia's
    // now-stale message — reply OR holding — rather than talking over the
    // human. Shrinks the collision window from the whole generation time to a
    // sub-second read; a genuine simultaneous tie is still possible but rare.
    if (await humanTookOverDuringTurn(db, adapter, conversationId, turnStartIso)) {
      return { handled: false, reason: 'human_took_over' }
    }

    // AGENT-VERIFY-HANDOFF.1 — after N failed verify_identity attempts (default
    // 2), stop asking and hand off. Deterministic server-side counter so a model
    // that would keep re-asking can't loop the customer; the model's retry text
    // for this turn is discarded in favour of the handoff holding message. The
    // SLA sweep re-alerts if nobody picks it up.
    if (shouldHandoffAfterVerifyFail(verifyFails, verifyFailThreshold)) {
      try {
        await db.from(adapter.conversationsTable)
          .update({ agent_verify_attempts: 0 })
          .eq('id', conversationId)
      } catch { /* handoff still proceeds; the next re-arm resets anyway */ }
      await handoff(db, adapter, { ...common, reason: 'verify_failed', settings })
      return { handled: true, action: 'handoff', reason: 'verify_failed' }
    }

    // Persist the running attempt count when it changed (an under-threshold
    // failure, or a reset after a success). Best-effort; a turn with no verify
    // attempt leaves it unchanged and writes nothing.
    if (verifyFails !== (conv?.agent_verify_attempts ?? 0)) {
      try {
        await db.from(adapter.conversationsTable)
          .update({ agent_verify_attempts: verifyFails })
          .eq('id', conversationId)
      } catch { /* next turn recomputes from the stored value */ }
    }

    if (parsed.action === 'handoff') {
      await handoff(db, adapter, { ...common, reason: parsed.reason, settings })
      return { handled: true, action: 'handoff', reason: parsed.reason }
    }

    const sent = await sendAndLog(db, adapter, { ...common, text: parsed.text, options: parsed.options, settings })
    if (!sent) {
      // The reply existed and never reached the customer (the 2026-06-12
      // dead-token class). Staff pages ride a different provider than the
      // customer channel, so a WhatsApp outage doesn't block this. Debounced
      // hourly — a dead token fails every thread at once.
      await notifyDeadAir(db, adapter, {
        locationId, conversationId, reason: 'send_failed',
        sinceIso: hoursAgoIso(1),
        title: `${adapter.label} · reply could not be sent`,
        body: 'Mia composed a reply but the channel rejected the send, so the customer got nothing. Check the channel connection and follow up manually.',
      })
      return { handled: false, reason: 'send_failed' }
    }

    // AGENT-ACTIVITY.1 — let inbox staff know a customer is chatting with Mia,
    // so an agent-handled thread isn't invisible on their phone. Debounced to
    // once per active chat; fire-and-forget so it never blocks the reply. The
    // webhook suppresses its generic per-message push when the agent engages,
    // so this REPLACES that ping (rather than doubling up) for agent chats.
    try {
      if (shouldNotifyAgentActivity(conv?.agent_activity_notified_at)) {
        await db.from(adapter.conversationsTable)
          .update({ agent_activity_notified_at: new Date().toISOString() })
          .eq('id', conversationId)
        const who = (nameCol && conv?.[nameCol]) || 'A customer'
        await sendPushToInboxStaffAtLocation(locationId, {
          title: `${adapter.label} · ${who} is chatting with Mia`,
          body: 'The AI assistant is handling this conversation. Tap to view.',
          category: 'agent_activity',
          data: { type: 'agent_activity', conversation_id: conversationId, channel: adapter.name },
        })
      }
    } catch (err) {
      console.error(`[radar-agent] ${adapter.name} agent-activity push failed`, err?.message)
    }

    return { handled: true, action: 'reply', lastInboundSeenIso }
  } finally {
    await releaseAgentTurn(db, adapter, conversationId, claimStamp)
  }
}

// Send an agent reply + persist it + update the conversation.
// Returns true only when the provider accepted the send — false means
// the customer got NOTHING and the caller must report it (a swallowed
// send failure here returned { handled: true } during the 2026-06-12
// dead-token incident and hid the outage from every surface).
export async function sendAndLog(db, adapter, { conversationId, locationId, recipient, contactId, connection, text, options, settings }) {
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
      const r = await adapter.send(recipient, sendText, { locationId, connection, settings })
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
    // MIA-REVIEW.3 — a NEW handoff re-arms the SLA escalation. The stamp is
    // per-handoff by design (handoff-sla.js), but nothing ever cleared it, so
    // the second and every later handoff on a thread could breach in silence.
    handoff_escalated_at: null,
  }).eq('id', conversationId)

  try {
    const r = await adapter.send(recipient, holding, { locationId, connection, settings })
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

// Manager-push copy for a model (Anthropic API) failure taking the
// soft-handoff path — the customer got the holding message, but the reply
// they were owed never existed, so a human needs to pick the thread up.
// MIA-HYGIENE.4 — record an agent-side model failure in BOTH places that
// matter after the fact: the turn's decision trace (agent_decisions.meta, so
// the inbox can say why Mia went quiet) and error_events (mig 435, so the row
// outlives Vercel's log window and Sentinel can alert on it). Best-effort by
// construction — recordErrorEvent swallows its own failures and is storm-
// guarded, and this must never change whether the customer gets a reply.
function noteModelFailure(trace, adapter, { kind, status, attempts, message, conversationId }) {
  if (trace) {
    trace.error = {
      kind,
      ...(Number.isFinite(status) ? { status } : {}),
      ...(Number.isFinite(attempts) ? { attempts } : {}),
      ...(message ? { message: String(message) } : {}),
    }
  }
  return recordErrorEvent({
    vercel_id: null,
    runtime: process.env.NEXT_RUNTIME || null,
    // Not a route — name the agent path so these rows are filterable apart
    // from request failures.
    route_path: `agent:${adapter?.name || 'unknown'}${conversationId ? `:${conversationId}` : ''}`,
    route_type: 'agent',
    method: null,
    name: kind,
    message: String(message ?? (Number.isFinite(status) ? `HTTP ${status}` : kind)).slice(0, 500),
    digest: null,
  })
}

function modelFailureNotify(adapter) {
  return {
    title: `${adapter.label} · agent unavailable`,
    body: 'The AI agent could not generate a reply (model API failure). The customer got the holding message — needs a human.',
  }
}

// Distinct copy per abandoned-turn cause, so "the model refused", "the reply
// was too long" and "a lookup kept failing" don't all read as an outage.
const ABANDONED_TURN_BODY = {
  model_refusal: 'The AI agent declined to answer this message (model refusal). The customer got the holding message — needs a human.',
  model_truncated: 'The AI agent\'s reply was cut off by the length limit twice, so it was not sent. The customer got the holding message — needs a human.',
  tool_error: 'An agent lookup failed repeatedly during this conversation. The customer got the holding message — needs a human.',
}

function abandonedTurnNotify(adapter, reason) {
  return {
    title: `${adapter.label} · agent unavailable`,
    body: ABANDONED_TURN_BODY[reason] || ABANDONED_TURN_BODY.tool_error,
  }
}

// Debounced staff page for an outcome the CUSTOMER cannot see (a cap that
// silences Mia, a send that never landed). Keyed off agent_decisions rather
// than process memory so the debounce holds across serverless instances; the
// decision row for THIS turn is written by the wrapper after we return, so the
// first turn in the window pages and the rest don't. Never affects the turn.
async function notifyDeadAir(db, adapter, { locationId, conversationId, reason, sinceIso, title, body }) {
  try {
    if (!locationId) return
    const { count } = await db.from('agent_decisions')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('reason', reason)
      .gte('created_at', sinceIso)
    if ((count || 0) > 0) return
    await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
      title, body,
      category: adapter.pushCategory,
      data: { type: adapter.handoffType, conversation_id: conversationId },
    })
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} ${reason} push failed`, err?.message)
  }
}

// Conditional stamp of agent_last_reply_at — the atomic half of the
// soft-handoff debounce. True means this caller won the window and owes the
// customer the holding message. Fails OPEN: a DB error must not swallow the
// acknowledgement (a duplicate ack beats dead air).
async function claimSoftHandoff(db, adapter, conversationId) {
  const nowIso = new Date().toISOString()
  const gapIso = new Date(Date.now() - SOFT_NOTIFY_GAP_MS).toISOString()
  try {
    const { data } = await db.from(adapter.conversationsTable)
      .update({ agent_last_reply_at: nowIso })
      .eq('id', conversationId)
      .or(`agent_last_reply_at.is.null,agent_last_reply_at.lt.${gapIso}`)
      .select('id')
    return Array.isArray(data) && data.length > 0
  } catch {
    return true
  }
}

// The agent is on duty but can't produce a real reply: a non-text message
// it can't read (photo / voice / sticker), or — COMMS-AUDIT 2026-07-10 —
// a model API failure. Acknowledge the customer with the holding message
// and flag a human, but DON'T disable the agent — a follow-up text (or the
// API recovering) re-engages it. Debounced via agent_last_reply_at so a
// burst of photos / webhook retries during an outage sends ONE ack, not a
// string of them. `notify` overrides the push copy per cause.
async function softHandoff(db, adapter, { conversationId, locationId, recipient, contactId, connection, settings, lastReplyAt, reason = 'unsupported_type', notify = null }) {
  if (lastReplyAt && Date.now() - new Date(lastReplyAt).getTime() < SOFT_NOTIFY_GAP_MS) {
    return { handled: false, reason: 'soft_handoff_debounced' }
  }
  // The read above uses agent_last_reply_at as it was at the TOP of the turn,
  // and the unsupported_type / ai_cap / wallet_empty paths run BEFORE the
  // concurrency claim — two parallel webhook POSTs would both pass it. Win the
  // stamp atomically (same optimistic pattern as claimAgentTurn) before
  // sending anything.
  if (!(await claimSoftHandoff(db, adapter, conversationId))) {
    return { handled: false, reason: 'soft_handoff_debounced' }
  }
  const holding = (settings?.holding_message || '').trim() || DEFAULT_HOLDING_MESSAGE
  const now = new Date().toISOString()
  try {
    const r = await adapter.send(recipient, holding, { locationId, connection, settings })
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
      title: notify?.title || `${adapter.label} · non-text message`,
      body: notify?.body || "Customer sent a photo / voice / attachment the agent can't read — needs a human.",
      category: adapter.pushCategory,
      data: { type: adapter.handoffType, conversation_id: conversationId },
    })
  } catch (err) {
    console.error(`[radar-agent] ${adapter.name} soft-handoff push failed`, err?.message)
  }
  return { handled: true, action: 'soft_handoff', reason }
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
  // AGENT-REARM.2 — operator send routes stamp sent_by; agent + sequence /
  // automation sends leave it null, so sent_by IS the human signal.
  humanOutboundColumns: 'source, sent_by',
  isHumanOutbound: (m) => m.source !== 'agent' && m.sent_by != null,
  // Fires once the agent has committed to replying (gating + claim passed):
  // marks the inbound read and shows "typing…" while Claude composes.
  onEngage: async ({ waMessageId, locationId }) => {
    if (!waMessageId) return
    try { await sendTypingIndicator(waMessageId, { locationId }) }
    catch (e) { console.warn('[agent] typing indicator failed:', e?.message) }
  },
  // C3 — a reply that ends in a URL becomes a cta_url button message (body +
  // tappable button) instead of a raw link. Operator-editable button text;
  // plain text is byte-identical to before when no trailing URL.
  send: async (recipient, text, { locationId, settings }) => {
    const split = splitTrailingUrl(text)
    if (split) {
      const buttonText = (settings?.link_button_text || '').trim() || 'Open link'
      try {
        return await sendCtaUrlMessage(recipient, { bodyText: split.body, buttonText, url: split.url }, { locationId })
      } catch (e) {
        // cta_url rejected (rare) — fall back to the plain text send below.
        console.warn('[agent] cta_url send failed, falling back to text:', e?.message)
      }
    }
    return sendTextMessage(recipient, text, { locationId })
  },
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
