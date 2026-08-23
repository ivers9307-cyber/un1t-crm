// SHELLY-UI.4 — the location's adopted relays: list them, and adopt one more.
//
// ADOPT ORDER IS A SECURITY PROPERTY, NOT A STYLE CHOICE. The device must be
// proved to be on the CALLER'S OWN Shelly account before this route ever looks
// at who holds it. (device_id, channel) is UNIQUE across the whole estate
// (mig 562), so the holder query is necessarily cross-tenant — and if it ran
// first, POSTing a guessed MAC would answer "already in use elsewhere" for a
// device belonging to another business and "not found" otherwise. That is an
// existence oracle for other tenants' hardware, built out of two error
// messages. Proving account ownership first means every id a caller can ask
// about is one their own cloud account already told them about, so the holder
// answer discloses nothing they did not already have.
//
// The full order, and why each step is where it is:
//   (a) connection    — no account, nothing to prove anything against.
//   (b) device cap    — counted BEFORE the cloud call, so a location at the
//                       cap does not spend a slot in the shared 1 req/sec
//                       budget to be told no.
//   (c) on my account — the gate above.
//   (d) supported + channel — refuse what cannot be controlled, using the
//                       device's own reading rather than our database.
//   (e) holder        — safe to ask now.
//   (f) insert        — the UNIQUE index is the backstop for (e)'s race.
//
// WHAT GATE (c) ASSUMES, stated so it can be checked rather than inherited:
// that `/v2/devices/api/get` returns an entry ONLY for a device the supplied
// key can see, and simply omits every id it cannot. That is what makes "the id
// came back" equal to "this account owns it". IF SHELLY EVER ECHOES A PER-ID
// NOT-FOUND MARKER — an entry carrying the id and an error, or a bare id with
// no device data — the gate is VOID as written: presence would no longer prove
// ownership, and the check must be re-judged on the ITEM'S CONTENT (a real
// reading: gen, model, or channels) instead of on `.find()` alone. The v2 body
// shape in this repo was read from Shelly's docs, not from a live account (see
// status.js's header), so the diagnostics below exist to make a drift in that
// shape visible as a log line rather than as a wall of 404s blaming operators;
// verifying it against the real Stillorgan account is a live-gate item.
//
// locationId ALWAYS comes from withAuth's ctx; no handler here reads a
// location from the request.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logWarn, logError } from '@/lib/log'
import { createShellyClient } from '@/lib/shelly/client'
import { loadConnectionWithKey, loadPublicConnection, markKeyRejected } from '@/lib/shelly/connections'
import {
  normaliseGetItems, stateFromReading, resolveDeviceName, nameShapeDiagnostic, rawItemsOf, rawItemId,
} from '@/lib/shelly/status'
import { ShellyAdoptBody, MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'
// SHELLY-UI.5 — the column allowlist moved to src/lib/shelly/device-load.js
// when the detail routes appeared, so the list, the adopt response and every
// per-device answer project the SAME shape. Two copies is how a field ends up
// present on one route and absent on another.
import { DEVICE_COLUMNS } from '@/lib/shelly/device-load'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-devices'

// Operator copy for the two verdicts normaliseGetItem can reach. Keyed by the
// normaliser's `reason` so a new reason there shows up here as a missing key
// rather than as silent, wrong copy.
const UNSUPPORTED_COPY = {
  gen1: 'Gen1 devices are not supported yet',
  no_switch: 'This device has no switch to control',
}

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

// Did the account answer with SOMETHING? Used only to tell "no devices matched"
// apart from "the body was a shape we cannot read" in the diagnostics below.
// Deliberately shape-only: the body itself is never logged (client.js header).
const bodyLooksNonEmpty = (body) =>
  Array.isArray(body) ? body.length > 0 : !!body && typeof body === 'object' && Object.keys(body).length > 0

/**
 * GET — this location's adopted devices, plus enough connection state for the
 * page to explain itself without a second round trip.
 */
export const GET = withAuth({ permission: 'device_control' }, async ({ db, locationId }) => {
  const { data, error } = await db
    .from('shelly_devices')
    .select(DEVICE_COLUMNS)
    .eq('location_id', locationId)
    // name first so the page reads alphabetically; created_at breaks the tie
    // (name is nullable, and PostgREST orders NULLs last by default) so the
    // list is stable between polls rather than reshuffling unnamed rows.
    .order('name')
    .order('created_at')
    // One MORE than the cap, so a location AT the cap and one OVER it are
    // distinguishable. The cron reconciles MAX_DEVICES per tick and slices the
    // rest (reconcile.js), so anything past the cap is adopted but never
    // controlled — worth a log line rather than a silent tail.
    .limit(MAX_DEVICES_PER_LOCATION + 1)
  if (error) {
    logError(MODULE, 'device list failed', { locationId, error: error.message })
    return bad('Could not load your Shelly devices', 500)
  }
  let devices = data || []
  if (devices.length > MAX_DEVICES_PER_LOCATION) {
    logWarn(MODULE, 'device cap exceeded, excess devices hidden', { locationId, cap: MAX_DEVICES_PER_LOCATION })
    devices = devices.slice(0, MAX_DEVICES_PER_LOCATION)
  }

  const loaded = await loadPublicConnection(db, locationId)
  // THREE answers, not two. 'not_connected' is true and useful
  // (connected:false, status null). A db_error is neither — but it must not
  // cost the operator the list we DID read, and it must not be answered
  // `false` either: that would tell a live studio its plugs are unreachable
  // and offer the Connect form. So the uncertainty is carried in the payload
  // as connected:null / connection_status:'unknown', which Task 6 renders as
  // "Couldn't read the Shelly connection — retrying" over the cards that are
  // already on screen. (GET /api/shelly/connection still 500s on the same
  // case, and correctly: there the connection IS the payload, so there is
  // nothing left to return.)
  if (!loaded.ok && loaded.reason !== 'not_connected') {
    logError(MODULE, 'connection read failed', { locationId, reason: loaded.reason, error: loaded.error })
    return NextResponse.json({ success: true, devices, connected: null, connection_status: 'unknown' })
  }

  const status = loaded.ok ? loaded.connection.status : null
  return NextResponse.json({
    success: true,
    devices,
    connected: status === 'connected',
    // The status STRING as well as the boolean: 'action_needed' and 'error'
    // are both "not connected" to the flag, and the page must be able to tell
    // "re-paste your key" from "retrying" without a second call.
    connection_status: status,
  })
})

/**
 * POST — adopt one relay channel. See the file header for why the order of
 * the six steps below is load-bearing.
 */
export const POST = withAuth(
  { permission: 'device_control', schema: ShellyAdoptBody },
  async ({ user, db, locationId, input }) => {
    // ---- (a) connection ----------------------------------------------------
    const loaded = await loadConnectionWithKey(db, locationId)
    if (!loaded.ok) {
      if (loaded.reason === 'not_connected') {
        return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
      }
      logError(MODULE, 'connection read failed', { locationId, reason: loaded.reason, error: loaded.error })
      return bad('Could not read the Shelly connection', 500)
    }
    const conn = loaded.connection

    // ---- (b) device cap ----------------------------------------------------
    const { count, error: countError } = await db
      .from('shelly_devices')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
    if (countError) {
      // Refused, not waved through. Past the cap the cron slices the excess off
      // every tick, so an over-cap device is adopted, schedulable, editable and
      // silently never controlled — and device-health then grades it "Stale",
      // pointing the operator at a connection that is fine. A retryable 500 is
      // the cheaper failure.
      logError(MODULE, 'device count failed', { locationId, error: countError.message })
      return bad('Could not check how many devices this location has', 500)
    }
    // NEVER `count ?? 0`. PostgREST answers null for a count it did not
    // compute (a missing Prefer header, a driver quirk), and reading that as
    // "zero devices" waves through every adopt at a location that may be
    // sitting on the cap — the one thing this check exists to stop.
    if (typeof count !== 'number') {
      logError(MODULE, 'device count came back unusable', { locationId })
      return bad('Could not check how many devices this location has', 500)
    }
    if (count >= MAX_DEVICES_PER_LOCATION) {
      return bad(`This location has reached the limit of ${MAX_DEVICES_PER_LOCATION} devices`, 409, {
        code: 'device_cap',
      })
    }

    // ---- (c) prove the device is on the CALLER'S OWN account ---------------
    // ['status','settings'] rather than the client's default ['status']: the
    // name comes out of settings, and this is one of the two places that needs it.
    const res = await createShellyClient(conn).get([input.device_id], { select: ['status', 'settings'] })
    if (!res.ok) {
      if (res.kind === 'auth') {
        await markKeyRejected(db, locationId)
        return bad('Shelly rejected the stored key — re-paste it from the Shelly app', 409, { code: 'key_rejected' })
      }
      if (res.kind === 'rate_limited') {
        return bad('Shelly is busy — try again in a few seconds', 429, { code: 'rate_limited' })
      }
      logWarn(MODULE, 'adopt read failed', { locationId, kind: res.kind, statusCode: res.statusCode })
      return bad('Shelly cloud did not answer — try again in a minute', 502, { code: res.kind })
    }
    // Both sides are lowercase by construction — ShellyAdoptBody transforms the
    // input and normaliseGetItem lowercases the id — so this compare is exact
    // rather than case-folded at the call site. `.find()`, never `[0]`: a body
    // that echoed a different device would otherwise be adopted under the id
    // the operator asked for.
    const items = normaliseGetItems(res.body)
    if (!items.length && bodyLooksNonEmpty(res.body)) {
      // The account answered with SOMETHING and the normaliser recognised none
      // of it — i.e. the documented shape has drifted. Without this line that
      // failure presents as a 404 on every adopt in the estate, with copy that
      // blames the operator for a device they can see in the Shelly app.
      // Shape only, never the body itself.
      logWarn(MODULE, 'cloud get returned items we could not read — check the v2 body shape', {
        locationId,
        bodyType: Array.isArray(res.body) ? 'array' : typeof res.body,
        entries: Array.isArray(res.body) ? res.body.length : Object.keys(res.body || {}).length,
      })
    }
    const item = items.find((d) => d.device_id === input.device_id)
    if (!item) {
      // 404, and the copy says whose account: this is the gate that keeps the
      // holder check below from being an existence oracle, so it must not leak
      // WHY the id is unknown to us.
      return bad('Not found on this Shelly account', 404, { code: 'not_on_account' })
    }

    // An entry carrying an id and nothing else is the shape that would void
    // gate (c) — it is what a per-id "not found" marker would look like, and
    // presence would then no longer prove ownership. Nothing observed does
    // this today, so it is a warning rather than a refusal (refusing would
    // block adopts on a body we have never seen); if this line ever fires,
    // re-read the file header before touching anything else.
    if (item.gen == null && item.model == null && !item.channels?.length) {
      logWarn(MODULE, 'cloud get echoed an id with no device data — ownership gate may be void', {
        locationId, online: item.online,
      })
    }

    // ---- (d) supported, and the channel exists -----------------------------
    // ONLY an explicit false refuses. `supported: null` means the device
    // reported nothing to judge (status.js rule 2) — usually an offline plug —
    // and refusing on it would make the single most common device in the
    // estate permanently unadoptable whenever it happened to be asleep.
    if (item.supported === false) {
      return bad(UNSUPPORTED_COPY[item.reason] || 'This device is not supported yet', 400, {
        code: 'unsupported',
        reason: item.reason ?? null,
      })
    }
    const channels = Array.isArray(item.channels) ? item.channels : []
    if (channels.length) {
      if (!channels.some((c) => c?.channel === input.channel)) {
        return bad(`This device has no channel ${input.channel}`, 400, { code: 'bad_channel' })
      }
    } else if (input.channel !== 0) {
      // No channels in the reading is "we heard nothing", not "it has none" —
      // an offline device reports no switch components at all. Channel 0 is
      // the one every relay has, so it is allowed on faith; anything higher
      // would be adopting a channel nobody has ever seen, and a row pinned to
      // a channel that does not exist can never match a real switch.
      return bad(
        `We can't see this device's channels while it's offline. Bring it online and adopt channel ${input.channel} then — only channel 0 can be adopted from here.`,
        400,
        { code: 'bad_channel' },
      )
    }

    // ---- (e) who holds this channel (cross-tenant BY DESIGN) ---------------
    // Estate-wide on purpose: (device_id, channel) is UNIQUE across every
    // location, so the answer this needs cannot come from our own rows. Sound
    // only on the service-role client — an RLS-bound one would answer "no
    // holder" for a foreign row, which is the answer that ALLOWS the adopt.
    // Reached only after (c) proved the caller already knows this device.
    // 0 rows is the ordinary "free" answer, hence .maybeSingle().
    const { data: holder, error: holderError } = await db
      .from('shelly_devices')
      // Unhinted embed — one FK to locations, and this is the form
      // connections.js and reconcile.js already run against the live database.
      .select('location_id, locations(name, organization_id)')
      .eq('device_id', input.device_id)
      .eq('channel', input.channel)
      .limit(1)
      .maybeSingle()
    if (holderError) {
      // A failed read is not evidence the channel is free. Proceeding would
      // hit the UNIQUE index anyway, but as an opaque 23505 instead of the
      // sentence that tells the operator what to do about it.
      logError(MODULE, 'holder check failed', { locationId, error: holderError.message })
      return bad('Could not check whether this device is already in use', 500)
    }
    if (holder) {
      if (holder.location_id === locationId) {
        return bad('Already adopted at this location', 409, { code: 'adopted_here' })
      }
      const holderOrg = holder.locations?.organization_id
      const callerOrg = user.activeLocation?.organization_id
      // Both present AND equal — see the same rule in classifyFingerprintClash.
      // A blank org on either side must never match, or a dropped embed would
      // name another business's studio.
      if (holderOrg && callerOrg && holderOrg === callerOrg) {
        return bad(`Already in use at ${holder.locations?.name || 'another location'}`, 409, { code: 'adopted' })
      }
      // Generic, naming nobody: same tenancy rule as the cross-org refusal on
      // the connection route.
      return bad('This device is already in use elsewhere', 409, { code: 'adopted' })
    }

    // SHELLY-NAMES.1 — the name is resolved off the RAW item and the channel
    // being adopted, not off the normalised row. Two reasons, and both were
    // live failures:
    //
    //   * normaliseGetItem resolves against channel 0, which is right for a
    //     single-relay plug and wrong for a Pro 4PM — every one of its four
    //     rows would take the same label.
    //   * six Gen3 relays adopted at Stillorgan with no name at all and NOT
    //     ONE warning, so `settings` came back and the label was somewhere the
    //     old two-place lookup does not look. resolveDeviceName is the wider
    //     net; nameShapeDiagnostic below is how we find out where it really
    //     lives, since nothing on this surface stores a raw Shelly payload.
    //
    // `?? item.name` is belt-and-braces for the case where the raw item cannot
    // be re-found in the body (it always can — `items` was derived from it) —
    // a name we already resolved must never be lost to a defensive lookup.
    const rawItem = rawItemsOf(res.body).find((x) => rawItemId(x) === input.device_id)
    const resolvedName = resolveDeviceName(rawItem, input.channel) ?? item.name ?? null
    if (!resolvedName) {
      // KEYS ONLY. `settings` carries the device's wifi and MQTT credentials,
      // so nothing here may be a value out of the payload — see
      // nameShapeDiagnostic. This is the line the live gate is waiting on.
      logWarn('shelly.adopt', 'no device name in the Shelly payload', {
        locationId, deviceId: input.device_id, channel: input.channel, shape: nameShapeDiagnostic(rawItem),
      })
    }

    // ---- (f) insert --------------------------------------------------------
    const nowIso = new Date().toISOString()
    const { data: row, error: insertError } = await db
      .from('shelly_devices')
      .insert({
        location_id: locationId,
        device_id: input.device_id,
        channel: input.channel,
        // The operator's name wins, then the Shelly account's own, then null.
        // Null rather than a synthesised "Plug 1a2b": the card renders its own
        // placeholder, and a stored fake name is indistinguishable from one a
        // human chose the moment anyone looks at the row.
        name: input.name ?? resolvedName,
        model: item.model,
        gen: item.gen,
        // Adopted is not armed. Nothing about a plug appearing in the list
        // should move a relay; the operator enables it once a schedule exists.
        enabled: false,
        schedule_mode: 'none',
        fixed_windows: [],
        class_rule: {},
        // The FULL last_state shape, from the reading we already have — every
        // writer writes all seven fields (mig 562's column comment), and an
        // offline device correctly lands output:null = unknown, never "off".
        last_state: stateFromReading(null, item, input.channel, nowIso),
        // Only a device that actually answered has been "seen". Stamping now
        // for an offline plug would start its health clock green on evidence
        // we never had.
        last_seen_at: item.online ? nowIso : null,
        adopted_by: user.id,
      })
      .select(DEVICE_COLUMNS)
      .single()
    if (insertError) {
      if (insertError.code === '23505') {
        // The race between (e) and here: someone adopted this channel in the
        // interval. Generic — we did not look up who, and the UNIQUE index
        // does not tell us, so there is nothing to name even if we wanted to.
        logWarn(MODULE, 'adopt lost the race to the unique index', { locationId })
        return bad('This device is already in use elsewhere', 409, { code: 'adopted' })
      }
      if (insertError.code === '23514') {
        // A CHECK message echoes the offending value, so it is mapped rather
        // than surfaced.
        logWarn(MODULE, 'adopt failed a CHECK', { locationId, error: insertError.message })
        return bad('Shelly rejected the device id or channel', 400)
      }
      logError(MODULE, 'adopt insert failed', { locationId, code: insertError.code, error: insertError.message })
      return bad('Could not adopt this device', 500)
    }
    if (!row) {
      // .single() errors on any row count but one, so this is the braces to
      // that belt — but it matters: `device: null` would be a 201 the page
      // renders as a successful adopt with nothing in it.
      logError(MODULE, 'adopt insert returned no row', { locationId })
      return bad('Could not adopt this device', 500)
    }

    return NextResponse.json({ success: true, device: row }, { status: 201 })
  },
)
