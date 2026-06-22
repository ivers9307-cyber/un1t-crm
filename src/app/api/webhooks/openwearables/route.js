// POST /api/webhooks/openwearables
//
// Open Wearables (OW) webhook receiver — the final inbound seam of the
// Apple-Watch ingestion feature (WEARABLE-INGEST). It turns an OW
// `workout.created` event into a `heart_rate_sessions` row so an
// off-site Apple Watch workout lands in the member's HR history (and,
// when it falls inside a class window, is class-correlated like a
// strap session).
//
// Flow (the prior IB tasks tie together here):
//   1. Verify the Svix signature (the security boundary — see below).
//   2. Filter to workout.created; pull { provider, user_id, workout_id }
//      from the thin payload (Svix sends ids, not full data).
//   3. Resolve the member via hr_provider_connections (provider +
//      provider_user_id + status='active' → contact_id). Unknown /
//      disconnected user → 200 (never error).
//   4. Fetch the workout + HR series via the OW client (IB1) and map
//      to the session field set (IB2).
//   5. Class-correlate against the schedule spine (class_occurrences).
//   6. Dedupe: skip if this workout already landed (re-delivery guard),
//      or if a richer strap session already owns the class slot.
//   7. Insert + finalizeSessionRewards (IB3 makes it import-safe).
//
// Svix delivery. OW delivers via Svix, so the request carries
//   svix-id, svix-timestamp, svix-signature
// headers and a JSON body shaped like a Svix message:
//   { id, eventType: 'workout.created', eventId?, timestamp, payload: {...} }
// (confirmed against the live OW server: GET /openapi.json
// WebhookMessageResponse + GET /api/v1/webhooks/event-types lists
// `workout.created` = "A new workout session was saved.", and the
// endpoint secret is a Svix `whsec_...` key — GET
// /api/v1/webhooks/endpoints/{id}/secret → EndpointSecretResponse.key).
//
// Signature scheme (Svix): HMAC-SHA256, key = base64-decode of the
// endpoint secret with its `whsec_` prefix stripped, over the exact
// string `${svixId}.${svixTimestamp}.${rawBody}`, base64-encoded, and
// constant-time-compared against each space-separated `v1,<sig>` entry
// in svix-signature. Reject if none match or the timestamp is > 5 min
// old (replay window). Secret from OPENWEARABLES_WEBHOOK_SECRET.
//
// We trust two things off the wire: the signature, and the ids in the
// payload. Everything else (workout detail, HR series) is fetched fresh
// via the OW client — the thin Svix payload can omit or stale-cache it.

import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { safeEqual } from '@/lib/webhook-auth'
import { createOpenWearablesClient } from '@/lib/openwearables'
import { mapAppleWorkoutToSession } from '@/lib/openwearables-map'
import { resolveMaxHr, resolveScoringConfig } from '@/lib/heart-rate'
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'
import { lookupBookedMember } from '@/lib/class-bookings'
import { finalizeSessionRewards } from '@/lib/live-class'

// node:crypto for the HMAC verification — force the Node.js runtime.
export const runtime = 'nodejs'

// The only event type we act on. OW also emits sync.*, heart_rate.*,
// sleep.created, etc. — all ignored (200, no work). Confirmed live via
// GET /api/v1/webhooks/event-types.
const WORKOUT_EVENT_TYPES = new Set(['workout.created', 'workout.updated'])

// Replay window: reject a Svix timestamp older (or further in the
// future) than this. Svix's own recommended tolerance is 5 minutes.
const SVIX_TOLERANCE_MS = 5 * 60 * 1000

/**
 * Verify a Svix webhook signature. PURE + exported so the security
 * boundary is unit-testable without standing up the handler.
 *
 * Svix scheme:
 *   secret    = base64-decode(endpointSecret without its `whsec_` prefix)
 *   signed    = `${svixId}.${svixTimestamp}.${rawBody}`
 *   expected  = base64( HMAC-SHA256(secret, signed) )
 *   header    = space-separated list of `v1,<base64sig>` (version-tagged;
 *               multiple entries support secret rotation — any match wins)
 *
 * Also enforces the ±5-minute timestamp replay window.
 *
 * @param {object} args
 * @param {{ get: (name: string) => string|null } | Record<string,string|null>} args.headers
 *        The request headers — either a Headers-like object (`.get`) or a
 *        plain lowercased map.
 * @param {string} args.rawBody  Exact request body bytes (read via
 *        request.text() BEFORE JSON.parse).
 * @param {string|undefined} args.secret  OPENWEARABLES_WEBHOOK_SECRET.
 * @param {number} [args.nowMs=Date.now()]  Injectable clock for tests.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyOpenWearablesSignature({ headers, rawBody, secret, nowMs = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'missing_secret' }

  const getHeader = (name) => {
    if (!headers) return null
    if (typeof headers.get === 'function') return headers.get(name)
    return headers[name] ?? headers[name.toLowerCase()] ?? null
  }

  const svixId = getHeader('svix-id')
  const svixTimestamp = getHeader('svix-timestamp')
  const svixSignature = getHeader('svix-signature')
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, reason: 'missing_headers' }
  }

  // Replay window — svix-timestamp is Unix SECONDS.
  const tsSec = Number(svixTimestamp)
  if (!Number.isFinite(tsSec)) return { ok: false, reason: 'bad_timestamp' }
  const skewMs = Math.abs(nowMs - tsSec * 1000)
  if (skewMs > SVIX_TOLERANCE_MS) return { ok: false, reason: 'timestamp_out_of_tolerance' }

  // Decode the endpoint secret (strip the `whsec_` prefix, base64-decode
  // the rest). A malformed secret can't sign anything → fail closed.
  let key
  try {
    const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
    key = Buffer.from(raw, 'base64')
    if (key.length === 0) return { ok: false, reason: 'bad_secret' }
  } catch {
    return { ok: false, reason: 'bad_secret' }
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`
  const expected = crypto.createHmac('sha256', key).update(signedContent, 'utf8').digest('base64')

  // svix-signature is space-separated `v1,<sig>` entries. Compare each
  // candidate's signature portion (after the version tag) in constant time.
  const candidates = svixSignature.split(' ')
  for (const entry of candidates) {
    const commaIdx = entry.indexOf(',')
    if (commaIdx === -1) continue
    const version = entry.slice(0, commaIdx)
    if (version !== 'v1') continue
    const sig = entry.slice(commaIdx + 1)
    if (safeEqual(expected, sig)) return { ok: true }
  }
  return { ok: false, reason: 'no_matching_signature' }
}

/**
 * Pull { provider, userId, workoutId } from a workout.created Svix
 * payload. Defensive about the exact nesting OW uses — accepts the ids
 * at the payload root and tolerates snake/camel + a nested `workout`/
 * `data` object, so a minor payload-shape difference doesn't silently
 * drop a real event. Returns nulls for anything missing; the caller
 * 200s-and-skips when an id is absent.
 *
 * @param {object|null} payload  the Svix message `payload` object
 * @returns {{ provider: string|null, userId: string|null, workoutId: string|null }}
 */
export function extractWorkoutRef(payload) {
  const p = payload || {}
  const inner = (p.workout && typeof p.workout === 'object' ? p.workout : null)
    || (p.data && typeof p.data === 'object' ? p.data : null)
    || {}
  const pick = (...vals) => {
    for (const v of vals) {
      if (v !== undefined && v !== null && v !== '') return String(v)
    }
    return null
  }
  return {
    provider: pick(p.provider, p.provider_name, inner.provider, inner.provider_name),
    userId: pick(p.user_id, p.userId, inner.user_id, inner.userId),
    workoutId: pick(p.workout_id, p.workoutId, inner.workout_id, inner.workoutId, inner.id),
  }
}

export async function POST(request) {
  // Read the raw body FIRST — the Svix signature is over the exact bytes;
  // request.json() would consume the stream and a re-serialise wouldn't
  // byte-match.
  const rawBody = await request.text()
  const secret = process.env.OPENWEARABLES_WEBHOOK_SECRET

  // Fail CLOSED if the secret isn't configured — these events create
  // member-facing HR rows, so spoofable inbound is not acceptable. 401
  // (not 200) so the misconfiguration surfaces.
  if (!secret) {
    console.error('[ow-webhook] OPENWEARABLES_WEBHOOK_SECRET is not set — refusing (fail closed)')
    return NextResponse.json({ success: false, error: 'Server misconfigured' }, { status: 401 })
  }

  const verified = verifyOpenWearablesSignature({ headers: request.headers, rawBody, secret })
  if (!verified.ok) {
    console.warn(`[ow-webhook] rejected: ${verified.reason}`)
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  // Past the security boundary: every verified-but-unprocessable event
  // returns 200 so OW/Svix doesn't disable the endpoint.
  let message
  try {
    message = JSON.parse(rawBody)
  } catch {
    // Empty/non-JSON body (e.g. a Svix endpoint validation handshake).
    return NextResponse.json({ success: true })
  }

  const eventType = message?.eventType || message?.type
  if (!WORKOUT_EVENT_TYPES.has(eventType)) {
    return NextResponse.json({ success: true, ignored: eventType || 'unknown' })
  }

  const { provider, userId, workoutId } = extractWorkoutRef(message?.payload)
  if (!userId || !workoutId) {
    console.warn('[ow-webhook] workout event missing user_id/workout_id — skipping')
    return NextResponse.json({ success: true, skipped: 'incomplete_payload' })
  }
  // The hr_provider_connections.provider CHECK only knows our canonical
  // provider keys; an OW `provider` of 'apple'/'applehealth' maps to
  // 'apple_health'. Default to apple_health (the only provider this
  // feature ingests today) when OW omits it.
  const connectionProvider = normaliseProvider(provider)

  const db = createServerClient()

  // ── 3. Resolve the member ──────────────────────────────────────────
  const { data: connection } = await db
    .from('hr_provider_connections')
    .select('id, contact_id')
    .eq('provider', connectionProvider)
    .eq('provider_user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (!connection?.contact_id) {
    // Unknown or disconnected OW user — nothing to attach the workout to.
    // 200, never error (a deleted/revoked connection is a normal state).
    console.warn(`[ow-webhook] no active ${connectionProvider} connection for ow user ${userId}`)
    return NextResponse.json({ success: true, skipped: 'unknown_user' })
  }

  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id, max_hr_override, dob')
    .eq('id', connection.contact_id)
    .maybeSingle()
  if (!contact?.location_id) {
    console.warn(`[ow-webhook] contact ${connection.contact_id} missing/locationless — skipping`)
    return NextResponse.json({ success: true, skipped: 'no_location' })
  }
  const locationId = contact.location_id

  const { data: location } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .maybeSingle()

  // ── 4. Fetch + map ──────────────────────────────────────────────────
  let workout
  let hrSamples
  try {
    const client = createOpenWearablesClient()
    workout = await client.getWorkout({ provider: provider || 'apple', userId, workoutId })
    if (!workout) {
      return NextResponse.json({ success: true, skipped: 'workout_not_found' })
    }
    if (workout.start_time && workout.end_time) {
      hrSamples = await client.getHeartRateTimeseries({
        userId,
        startIso: workout.start_time,
        endIso: workout.end_time,
      })
    } else {
      hrSamples = []
    }
  } catch (e) {
    // OW unreachable / config missing — let Svix retry (the event was
    // valid). Don't 500: 200 keeps the endpoint healthy, and Svix's own
    // retry schedule re-delivers; the workout-id dedup makes that safe.
    console.warn(`[ow-webhook] OW fetch failed for workout ${workoutId}: ${e?.message || e}`)
    return NextResponse.json({ success: true, skipped: 'ow_fetch_failed' })
  }

  const session = mapAppleWorkoutToSession({
    workout,
    hrSamples,
    maxHr: resolveMaxHr(contact),
    scoring: resolveScoringConfig(location),
    provider: provider || 'apple',
  })
  session.contact_id = contact.id
  session.location_id = locationId

  // The OW workout id (canonical dedup key). The mapper stamps it into
  // raw_metadata.ow_workout_id; use the workout's own id as the source of
  // truth (it's what re-deliveries carry).
  const owWorkoutId = workout.id ?? workoutId

  // ── 5. Class-correlate ──────────────────────────────────────────────
  // Anchor on the WORKOUT'S start time, not now — an imported workout is
  // historical. If a class was live then, stamp the class link.
  const workoutStartMs = Date.parse(workout.start_time)
  if (Number.isFinite(workoutStartMs)) {
    const occ = await resolveCurrentOccurrence(db, { locationId, nowMs: workoutStartMs })
    if (occ?.glofox_event_id) {
      session.glofox_event_id = occ.glofox_event_id
      session.class_name = occ.class_name ?? null
      // 'booked' if the member had a booking for this class, else leave
      // class_link_source null (keep it simple — the CHECK allows null,
      // and we don't claim 'presence' for an off-site import we're not
      // certain about). The class link itself (glofox_event_id) is what
      // makes finalizeSessionRewards treat it as a class session.
      let booked = false
      try {
        const { data: c } = await db
          .from('contacts')
          .select('glofox_member_id')
          .eq('id', contact.id)
          .maybeSingle()
        booked = await lookupBookedMember(db, {
          locationId,
          glofoxEventId: occ.glofox_event_id,
          glofoxMemberId: c?.glofox_member_id ?? null,
        })
      } catch (e) {
        console.warn(`[ow-webhook] booking lookup failed for contact ${contact.id}: ${e?.message || e}`)
      }
      session.class_link_source = booked ? 'booked' : null
    }
  }

  // ── 6. Dedupe (idempotent) ──────────────────────────────────────────
  // (a) Re-delivery guard — this exact workout already landed.
  const { data: existingByWorkout } = await db
    .from('heart_rate_sessions')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('source', 'apple_health')
    .filter('raw_metadata->>ow_workout_id', 'eq', String(owWorkoutId))
    .limit(1)
    .maybeSingle()
  if (existingByWorkout?.id) {
    return NextResponse.json({ success: true, deduped: 'workout_already_ingested' })
  }

  // (b) Strap-session-wins guard — if this is class-correlated and a
  // richer session already exists for the same (contact, class), the
  // strap session is the authoritative record (it has real per-sample
  // data from our own bridge). Same dedupe spirit as credit-attendance.
  if (session.glofox_event_id) {
    const { data: richer } = await db
      .from('heart_rate_sessions')
      .select('id, source')
      .eq('contact_id', contact.id)
      .eq('glofox_event_id', session.glofox_event_id)
      .neq('source', 'apple_health')
      .limit(1)
      .maybeSingle()
    if (richer?.id) {
      return NextResponse.json({ success: true, deduped: 'richer_session_exists' })
    }
  }

  // ── 7. Insert + finalise ────────────────────────────────────────────
  const { data: inserted, error: insertErr } = await db
    .from('heart_rate_sessions')
    .insert(session)
    .select('id')
    .single()
  if (insertErr || !inserted) {
    console.error(`[ow-webhook] insert failed for workout ${owWorkoutId}: ${insertErr?.message}`)
    // 200 — a transient DB error is retried by Svix; the workout-id
    // dedup guard above keeps the retry idempotent.
    return NextResponse.json({ success: true, skipped: 'insert_failed' })
  }

  // Best-effort reward cascade (IB3 made it import-safe: post-class email
  // only when class-correlated, no external export for apple_health). Fire-
  // and-forget per the repo convention — never block / fail the 200.
  let finalised = false
  try {
    await finalizeSessionRewards(db, inserted.id, { nowMs: Date.now() })
    finalised = true
  } catch (e) {
    console.warn(`[ow-webhook] finalizeSessionRewards threw for session ${inserted.id}: ${e?.message || e}`)
  }

  return NextResponse.json({
    success: true,
    inserted: inserted.id,
    classLinked: !!session.glofox_event_id,
    finalised,
  })
}

/**
 * Normalise an OW provider key to one of our hr_provider_connections
 * provider values. OW's Apple provider may arrive as 'apple',
 * 'apple_health', or 'applehealth' — all map to our 'apple_health'.
 * Anything we already recognise (fitbit/whoop/garmin) passes through;
 * an unknown/absent value defaults to apple_health (the only provider
 * this ingestion path serves today).
 */
function normaliseProvider(provider) {
  const KNOWN = new Set(['apple_health', 'fitbit', 'whoop', 'garmin'])
  if (!provider) return 'apple_health'
  const p = String(provider).toLowerCase()
  if (KNOWN.has(p)) return p
  if (p === 'apple' || p === 'applehealth' || p === 'apple-health' || p === 'healthkit') {
    return 'apple_health'
  }
  return 'apple_health'
}

// Svix performs an endpoint validation handshake by POSTing; some
// callers also probe with GET. Return 200 so the URL is considered
// reachable when an operator registers it.
export async function GET() {
  return NextResponse.json({ success: true, ok: 'openwearables webhook endpoint' })
}
