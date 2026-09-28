// WEBHOOKAUDIT.1 — one PII-free row per processed Glofox webhook delivery.
//
// WHY. glofox_webhook_events.event_id is Glofox's ENTITY id (Payload.id: the
// booking, invoice, member or event), not an id for the emission — that is
// Metadata.trace_id. So every later event about the same booking lands on the
// SAME row, and the ingest upsert plus markEvent overwrite its event_type,
// payload, status and result. Prod, 30 days to 28 Sep 2026: 70% of rows held
// a later emission than the one that created them (93% of BOOKING_UPDATED);
// only 2 were a late re-process of the same emission. The row shows only the
// LAST event per entity, which is why C13 could not tell which delivery
// flipped a member's label.
//
// This module keeps the history beside the row (table glofox_webhook_attempts,
// mig 649) WITHOUT changing what the row means or how a delivery is processed:
//   - digestGlofoxWebhookResult(): an ALLOWLIST projection of the route's
//     result. The stored result carries the member's name, email, phone, date
//     of birth, emergency contact and signup answers (member_sync.existing /
//     mapped / changes). The digest keeps changed column NAMES, the from/to of
//     TRACKED_MEMBER_COLUMNS, and action/reason codes. Add a field here only
//     if it is a code, a count, a flag or one of our own uuids.
//   - buildGlofoxWebhookAttempt(): the row. Never throws.
//   - recordGlofoxWebhookAttempt(): the insert. Never throws; a failure is one
//     logWarn and the delivery carries on exactly as before ("never louder").
import { logWarn } from '@/lib/log'

export const GLOFOX_ATTEMPTS_TABLE = 'glofox_webhook_attempts'
/**
 * glofox_webhook_attempts_digest_size (mig 649): octet_length(digest::text)
 * <= 4000. That measures jsonb's TEXT form, which puts a space after every
 * ':' and ',' and so runs longer than JSON.stringify.
 */
export const DB_MAX_DIGEST_BYTES = 4000
/**
 * The cap this module applies, on JSON.stringify's UTF-8 bytes. The 500-byte
 * headroom covers jsonb's extra spaces (one per key and per list element; a
 * full digest has well under 300), so a digest the JS keeps is never refused
 * by the CHECK (migration-649 test inserts the largest one).
 */
export const MAX_DIGEST_BYTES = 3500
/** Mirrors glofox_webhook_attempts_error_size (mig 649). */
export const MAX_ERROR_CHARS = 500

const MAX_CHANGED = 60
const MAX_TAGS = 20
const MAX_NAME = 60
const MAX_TEXT = 120
const MAX_LABEL = 40

/**
 * The member columns whose before/after the digest keeps. Each is a Glofox
 * label, a flag or a count, never personal data. These are the columns the
 * membership-label and credits questions (C13) turn on.
 */
export const TRACKED_MEMBER_COLUMNS = Object.freeze([
  'glofox_membership_status',
  'glofox_membership_state',
  'glofox_membership_type',
  'glofox_account_active',
  'trial_credits_remaining',
])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : null)
const flag = (v) => (typeof v === 'boolean' ? v : null)
const label = (v) => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v.slice(0, MAX_LABEL)
  return null
}
const names = (arr, max) =>
  (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string').slice(0, max).map((s) => s.slice(0, MAX_NAME)) : [])
const byteLength = (s) => new TextEncoder().encode(s).length

function digestMemberSync(ms) {
  if (!isObj(ms)) return null
  const changes = isObj(ms.changes) ? ms.changes : {}
  const tracked = {}
  for (const col of TRACKED_MEMBER_COLUMNS) {
    const c = changes[col]
    if (isObj(c)) tracked[col] = { from: label(c.from), to: label(c.to) }
  }
  const existing = isObj(ms.existing) ? ms.existing : {}
  const mapped = isObj(ms.mapped) ? ms.mapped : {}
  const deal = ms.deal_action
  // applyMemberSync's transition_tags is writeContactTags()'s result
  // (src/lib/contact-tags.js): null (no transition), { written, alreadyPresent }
  // (optionally with `error` on a refused insert) or { error } (it threw). The
  // error text is never kept — only that there was one.
  const tt = isObj(ms.transition_tags) ? ms.transition_tags : {}
  return {
    action: text(ms.action, MAX_LABEL),
    ok: flag(ms.ok),
    reason: text(ms.reason),
    http_status: typeof ms.status === 'number' && Number.isFinite(ms.status) ? ms.status : null,
    credits_unread: ms.credits_unread === true,
    changed: Object.keys(changes).sort().slice(0, MAX_CHANGED).map((k) => k.slice(0, MAX_NAME)),
    tracked,
    seen: {
      existing_status: label(existing.glofox_membership_status),
      mapped_status: label(mapped.glofox_membership_status),
      existing_credits: label(existing.trial_credits_remaining),
      mapped_credits: label(mapped.trial_credits_remaining),
    },
    deal_action: isObj(deal) ? text(deal.action, MAX_LABEL) : text(deal, MAX_LABEL),
    transition_tags: names(tt.written, MAX_TAGS),
    transition_tags_present: names(tt.alreadyPresent, MAX_TAGS),
    transition_tags_failed: tt.error !== undefined && tt.error !== null,
  }
}

/**
 * The PII-free digest of the webhook route's `result` object (the one
 * markEvent stores on glofox_webhook_events). Null for no result.
 * @param {unknown} result
 * @returns {object|null}
 */
export function digestGlofoxWebhookResult(result) {
  if (!isObj(result)) return null
  const ltv = isObj(result.ltv) ? result.ltv : null
  const dunning = isObj(result.dunning) ? result.dunning : null
  const service = isObj(result.service) ? result.service : null
  const pause = isObj(result.membership_pause) ? result.membership_pause : null
  const sc = service && isObj(service.state_change) ? service.state_change : null
  const digest = {
    contact_id: text(result.contact_id, 64),
    tags: names(result.tags, MAX_TAGS),
    member_sync: digestMemberSync(result.member_sync),
    ltv: ltv && {
      ok: flag(ltv.ok), reason: text(ltv.reason),
      invoice_status: text(ltv.invoice_status, MAX_LABEL), is_membership: flag(ltv.is_membership),
    },
    dunning: dunning && {
      kind: text(dunning.kind, MAX_LABEL), enrolled: flag(dunning.enrolled),
      exited: flag(dunning.exited), reason: text(dunning.reason),
    },
    service: service && {
      ok: flag(service.ok), reason: text(service.reason),
      state_change: sc && { from: label(sc.from), to: label(sc.to) },
    },
    membership_pause: pause && { ok: flag(pause.ok), paused: flag(pause.paused), cleared: flag(pause.cleared) },
  }
  if (byteLength(JSON.stringify(digest)) > MAX_DIGEST_BYTES) {
    return { oversize: true, contact_id: digest.contact_id, member_sync_action: digest.member_sync?.action ?? null }
  }
  return digest
}

function metadataOf(payload) {
  if (!isObj(payload)) return null
  if (isObj(payload.Metadata)) return payload.Metadata
  if (isObj(payload.metadata)) return payload.metadata
  return null
}

/** Glofox's Timestamp is an ISO string with a zone (100% of 30 days' rows). Anything else → null. */
function isoOrNull(v) {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * The glofox_webhook_attempts row for one delivery. Never throws: a result
 * that cannot be read becomes `{ digest_failed: true }`.
 */
export function buildGlofoxWebhookAttempt({
  eventRowId, locationId = null, parsed = null, payload = null,
  deliveredAt = null, processedAt = null, status, result = null, errorMessage = null,
}) {
  let digest
  try {
    digest = digestGlofoxWebhookResult(result)
  } catch {
    digest = { digest_failed: true }
  }
  const meta = metadataOf(payload)
  const processed = processedAt || new Date().toISOString()
  return {
    event_row_id: eventRowId,
    location_id: locationId || null,
    trace_id: text(meta?.trace_id, 64),
    event_type: text(parsed?.eventType, 64),
    emitted_at: isoOrNull(isObj(payload) ? (payload.Timestamp ?? payload.timestamp) : null),
    delivered_at: deliveredAt || processed,
    processed_at: processed,
    status: text(status, MAX_LABEL) || 'unknown',
    error_message: typeof errorMessage === 'string' ? errorMessage.slice(0, MAX_ERROR_CHARS) : null,
    digest,
  }
}

/**
 * Insert one attempt row. Never throws. A refused or thrown insert is one
 * logWarn (no Glofox ids, no payload) and `{ ok: false }`; the caller
 * carries on.
 */
export async function recordGlofoxWebhookAttempt(db, row) {
  try {
    const { error } = await db.from(GLOFOX_ATTEMPTS_TABLE).insert(row)
    if (error) {
      logWarn('glofox-webhook', 'attempt row insert failed', {
        status: row?.status ?? null, code: error.code || null, err: error.message,
      })
      return { ok: false, error }
    }
    return { ok: true, error: null }
  } catch (e) {
    logWarn('glofox-webhook', 'attempt row insert threw', { status: row?.status ?? null, err: e?.message })
    return { ok: false, error: e }
  }
}
