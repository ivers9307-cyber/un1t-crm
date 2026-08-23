// SHELLY-NAMES.1 — "Use Shelly names": copy the labels the operator already
// typed in the Shelly app onto this location's adopted rows.
//
// WHY IT EXISTS. Six Shelly 1 Mini Gen3 relays were adopted at Stillorgan and
// every card rendered the `<model> · <last4>` placeholder, even though all six
// are named in the Shelly app — and the adopt route logged NOTHING, so
// `settings` came back and the label was simply not where the old two-place
// lookup looked. Renaming six plugs by hand is a two-minute job; renaming them
// on every new studio, forever, is not. This is the button that fixes a
// location in one press, and — for any device that STILL resolves no name —
// the one that tells us where the label actually lives (see below).
//
// IT COMMANDS NOTHING. Reads and `name` writes only: no relay moves, no
// schedule is applied, no other column is touched. That is what makes it safe
// behind a button an operator can press twice, and it is why a rate limit is
// answered 429 rather than 502 — the shared 1 req/sec budget is most often the
// same owner's other studio mid-reconcile, and pressing again is the wrong
// move.
//
// THE ONE DESTRUCTIVE EDGE, and why the default is the other way round.
// `overwrite: true` replaces names a human typed on this surface, and nothing
// keeps the old one — there is no undo. So the schema defaults `overwrite` to
// false and the UI makes "All plugs" a separate, labelled choice: a request
// that merely forgot the field lands on the safe branch.
//
// THE DIAGNOSTIC IS KEYS-ONLY, ALWAYS. `settings` carries the device's wifi
// credentials (settings.wifi.sta.pass) and its MQTT broker password, so
// nameShapeDiagnostic emits key NAMES and typeof strings and never a value out
// of the payload. One warning per request, not one per device: the shape is
// the same for every plug on an account, and 50 copies of it would bury the
// answer it exists to give.
//
// locationId ALWAYS comes from withAuth's ctx, and every chain carries
// `.eq('location_id', …)` — service-role clients bypass RLS, so the WHERE
// clause IS the tenant boundary.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError, logWarn } from '@/lib/log'
import { createShellyClient, MAX_GET_IDS } from '@/lib/shelly/client'
import { loadConnectionWithKey, markKeyRejected } from '@/lib/shelly/connections'
import { DEVICE_COLUMNS } from '@/lib/shelly/device-load'
import { nameShapeDiagnostic, rawItemsOf, rawItemId, resolveDeviceName } from '@/lib/shelly/status'
import { ShellySyncNamesBody, MAX_DEVICES_PER_LOCATION } from '@/lib/shelly/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODULE = 'shelly-sync-names'

// A BUDGET, because this runs on a request thread and the client paces itself
// end-to-start at 1 req/sec. 50 devices is five batches plus the client's own
// 429 retry — the refresh route measured that shape at roughly 14 seconds, and
// a platform 504 would lose every name we had already resolved. Checked before
// each batch: we stop reading, WRITE what we have, and report `partial`.
const SYNC_BUDGET_MS = 8_000

// The same lowercasing the normaliser applies to a device id, so a raw cloud
// item and a database row can be matched up at all.
const idKey = (v) => String(v ?? '').trim().toLowerCase()

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

export const POST = withAuth(
  { permission: 'device_control', schema: ShellySyncNamesBody },
  async ({ db, locationId, input }) => {
    const loaded = await loadConnectionWithKey(db, locationId)
    if (!loaded.ok) {
      if (loaded.reason === 'not_connected') {
        return bad('Connect your Shelly account first', 409, { code: 'not_connected' })
      }
      // A read that FAILED is not "not connected" — answering that code would
      // send the operator to the Connect form to re-paste a working credential.
      logError(MODULE, 'connection read failed', { locationId, reason: loaded.reason, error: loaded.error })
      return bad('Could not read the Shelly connection', 500)
    }

    const { data, error } = await db
      .from('shelly_devices')
      .select(DEVICE_COLUMNS)
      .eq('location_id', locationId)
      // The cap the cron itself reconciles per tick. Naming devices no
      // schedule will ever act on would spend the shared budget on rows the
      // engine slices off anyway.
      .limit(MAX_DEVICES_PER_LOCATION)
    if (error) {
      logError(MODULE, 'device list failed', { locationId, error: error.message })
      return bad('Could not load your Shelly devices', 500)
    }
    const devices = data || []
    if (!devices.length) {
      // No cloud call at all: a location with nothing adopted spending a slot
      // of the shared account budget to learn that would starve the studio next
      // door mid-reconcile.
      return NextResponse.json({
        success: true, total: 0, updated: 0, unchanged: 0, unresolved: 0, write_failures: 0,
      })
    }

    // One read per DEVICE, not per row: a 4PM adopted on all four channels is
    // four rows and one device, and asking for its id four times would burn
    // four slots of a ten-wide batch on the same answer.
    const seen = new Set()
    const ids = []
    for (const d of devices) {
      const key = idKey(d?.device_id)
      if (!key || seen.has(key)) continue
      seen.add(key)
      ids.push(d.device_id)
    }

    // ONE client for the whole route, so its 1 req/sec pacing spans every
    // batch. A client per batch is a client that believes it has never called.
    const client = createShellyClient(loaded.connection)
    const rawById = new Map()
    // Only a batch that SUCCEEDED speaks for its ids — the same rule the
    // reconcile runs on. Without it a device in a failed batch would be
    // reported as "Shelly has no name for it", which is a claim we did not
    // earn, and would put an empty shape into the diagnostic that is supposed
    // to be the answer.
    const covered = new Set()
    let failKind = null
    let partial = false
    const deadlineAt = Date.now() + SYNC_BUDGET_MS

    for (let i = 0; i < ids.length; i += MAX_GET_IDS) {
      if (Date.now() > deadlineAt) {
        logWarn(MODULE, 'time budget exhausted — reads stopped', { locationId, done: i, remaining: ids.length - i })
        partial = true
        break
      }
      const batch = ids.slice(i, i + MAX_GET_IDS)
      // ['status','settings'] — the label lives in settings, and this is one of
      // the three places that needs it.
      const res = await client.get(batch, { select: ['status', 'settings'] })
      if (!res.ok) {
        if (res.kind === 'auth') {
          // Only `auth` is evidence about the credential, and it parks the
          // connection with the same three fields the cron writes. Nothing is
          // written here: the operator has to re-paste the key and press again
          // anyway, and a name is re-derivable on that next press — no work is
          // lost, unlike the read half below.
          await markKeyRejected(db, locationId)
          return bad('Shelly rejected the stored key — re-paste it from the Shelly app', 409, { code: 'key_rejected' })
        }
        if (res.kind === 'rate_limited') {
          // Same reasoning, and the same cheap retry: pressing again in a few
          // seconds costs the operator nothing.
          return bad('Shelly is busy — try again in a few seconds', 429, { code: 'rate_limited' })
        }
        // Anything else is a far end that may stay unreachable for a while, so
        // the names we DID resolve are written before the failure is reported
        // — a partial rename beats losing a completed read to an unrelated
        // blip on the batch after it.
        logWarn(MODULE, 'name read failed', { locationId, kind: res.kind, statusCode: res.statusCode })
        failKind = res.kind
        partial = true
        break
      }
      for (const id of batch) covered.add(idKey(id))
      for (const raw of rawItemsOf(res.body)) {
        const key = rawItemId(raw)
        if (key) rawById.set(key, raw)
      }
    }

    const nowIso = new Date().toISOString()
    let updated = 0
    let unchanged = 0
    let unresolved = 0
    let writeFailures = 0
    // The first raw item that carried no usable label, for the ONE diagnostic
    // below. An object is preferred over `undefined` (the account answered and
    // never mentioned the device) because an object is the case that can
    // actually tell us where the label lives.
    let sampleRaw

    for (const row of devices) {
      const key = idKey(row.device_id)
      // Never asked. Not "unresolved" — see `covered` above.
      if (!covered.has(key)) continue
      const raw = rawById.get(key)
      const name = resolveDeviceName(raw, row.channel)
      if (!name) {
        unresolved += 1
        if (sampleRaw === undefined && raw !== undefined) sampleRaw = raw
        continue
      }
      // The safe branch: a name typed on this surface is a human decision, and
      // nothing keeps the old one once it is replaced.
      if (row.name != null && !input.overwrite) { unchanged += 1; continue }
      if (name === row.name) { unchanged += 1; continue }

      const { data: written, error: writeError } = await db
        .from('shelly_devices')
        .update({ name, updated_at: nowIso })
        .eq('id', row.id)
        // The tenant boundary again, on the write. The row came from a scoped
        // read, so this is belt-and-braces — and it is the belt that survives a
        // future refactor of the read.
        .eq('location_id', locationId)
        .select('id')
      if (writeError) {
        // Counted and logged, never fatal: one unwritable row must not cost the
        // other 49 their names. The operator sees the count.
        writeFailures += 1
        logError(MODULE, 'name write failed', { locationId, deviceRowId: row.id, error: writeError.message })
        continue
      }
      if (!written?.length) {
        // A zero-row UPDATE is not an error in PostgREST, and reading it as a
        // success would report a name that never landed. The only way to get
        // here is the device being removed between the read and this write.
        writeFailures += 1
        logWarn(MODULE, 'name write touched no row — device removed mid-sync?', { locationId, deviceRowId: row.id })
        continue
      }
      updated += 1
    }

    if (unresolved > 0) {
      // ONE line, KEYS ONLY. This is the line the live gate is waiting on: it
      // says which keys the account's items actually carry, so the resolver can
      // be pointed at the right one. See nameShapeDiagnostic for why no value
      // from the payload may appear here.
      logWarn(MODULE, 'no device name in the Shelly payload', {
        locationId, unresolved, shape: nameShapeDiagnostic(sampleRaw),
      })
    }

    const counters = {
      total: devices.length,
      updated,
      unchanged,
      unresolved,
      write_failures: writeFailures,
      ...(partial ? { partial: true } : {}),
    }

    if (failKind) {
      // The names above are already written. `partial` is what tells the client
      // the counters describe part of the location rather than all of it.
      return bad('Shelly stopped answering — some plugs were not checked', 502, { code: failKind, ...counters })
    }
    return NextResponse.json({ success: true, ...counters })
  },
)
