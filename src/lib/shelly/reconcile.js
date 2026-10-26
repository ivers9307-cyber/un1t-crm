// SHELLY.8 — the per-minute reconcile. This is the only place the pure
// modules (client, status, plan, energy) are wired to the database, so it is
// also where every "who owns this decision" answer lives.
//
// SHAPE OF A TICK: load every connection, oldest success first → park the ones
// a human must fix and the ones that just failed → group them BY ACCOUNT → run
// the groups with a small concurrency pool. Within a group everything is
// serial, because Shelly's rate limit is 1 request per second PER ACCOUNT and an
// owner with two studios has two connection rows on ONE budget. The client paces
// itself but knows nothing about its siblings; if two same-account locations ran
// side by side they would each sit inside the limit and together breach it, and
// every second call would come back 429.
//
// GROUPING ALONE IS NOT ENOUGH, and this is the part that is easy to get wrong.
// Each location builds its OWN client, and a fresh client starts with
// lastCallAt = -Infinity — it believes it has never called. So location B's
// first request goes out milliseconds after location A's last one, inside the
// same account's budget, and earns a 429 plus a 1.1 s retry at EVERY handoff, on
// every tick, forever — with `rateLimited` never once reading zero. The group
// loop therefore sleeps MIN_GAP_MS between consecutive locations itself. An idle
// location still pays that gap; one second is the cheap side of the trade.
//
// ORDERING IS THE OTHER HALF. Connections are swept oldest-`last_ok_at` first,
// so a budget shortfall rotates through the estate instead of starving the same
// tail of the list every single minute.
//
// THE SIX THINGS THIS FILE IS CAREFUL ABOUT
//
//  1. BRANCH ON `kind`, NEVER ON `statusCode`. The client's statusCode 0 is
//     overloaded — network, bad host, caller bugs and the empty-list
//     short-circuit all wear it. `kind` is the vocabulary; `auth` and `config`
//     are the two that mean "stop calling and tell the operator", and they are
//     the only two that change the connection to action_needed.
//
//  2. A DEVICE IS ONLY WRITTEN FROM A BATCH THAT SUCCEEDED. A read that failed
//     tells us nothing about the devices in it, so they are skipped entirely —
//     not written offline. A device MISSING from a batch that SUCCEEDED is a
//     different fact ("the account answered and did not mention it") and does
//     get written offline. Conflating the two is how a network blip becomes a
//     wall of offline badges.
//
//  3. EXACTLY-ONCE IS THE STAMP, AND THE STAMP FOLLOWS THE COMMAND. last_applied
//     is written only for a device whose command actually landed — never for one
//     in `failedCommands`, never for a batch the client refused. An optimistic
//     stamp costs the whole window: the planner sees its own key already applied
//     and never retries.
//
//  4. NOTHING HERE LOGS A URL, A BODY, OR THE KEY. Results carry response bodies
//     verbatim (the client says so), so they are never logged; thrown errors go
//     through redactSecret first. The operator-facing `last_error` strings are
//     fixed literals plus a `kind`.
//
//  5. AN UNMADE REQUEST IS NOT EVIDENCE. When the tick runs out of budget before
//     any call, the connection status is left ALONE rather than stamped
//     'error' — a self-inflicted skip is not the Shelly cloud being unreachable,
//     and a false 'error' badge is indistinguishable from a real outage.
//
//  6. A FAILING ACCOUNT IS BACKED OFF, NEVER HAMMERED. Three brakes, because
//     one broken studio must not spend the budget its healthy siblings share.
//     A host that black-holes stops the read loop at the FIRST failure — with
//     no success behind it, the remaining batches fail identically — and skips
//     that tick's commands too. An 'error' connection is then left alone for
//     ERROR_RETRY_MS, and an 'action_needed' one for ACTION_NEEDED_RETRY_MS.
//     The operability rule underneath all three: a repeated failure must get
//     QUIETER, not louder. The same reasoning gates the two diagnostic warnings
//     below on a device having actually CHANGED state — a genuinely dark studio
//     would otherwise log the same line 1,440 times a night, which is how the
//     line that means "the integration is broken" becomes the one everybody
//     filters out.
//
// TESTABILITY: every dependency is injected (`now`, `sleep`, `makeClient`,
// `loadOccurrences`), house pattern. reconcileLocation and refreshLocationState
// are exported because PR 2's refresh route reads state through the same code
// path the cron does — two implementations of "read and store device state" is
// how a UI and a cron end up disagreeing about a relay.

import { logWarn, logError } from '@/lib/log'
import { mapWithConcurrency } from '@/lib/concurrency'
// TZ.10 — import swap only (tz-time was a shim onto these): the strict twins
// keep tz-time's throw-on-bad-instant / null-on-bad-date contract exactly.
import {
  addDaysISO, resolveZone as resolveTz, isValidZone as isValidTz,
  strictDayStrIn as dayStrInTz, strictDayStartMsIn as dayStartMsInTz,
} from '@/lib/location-time'
import { createShellyClient, MAX_GET_IDS, MIN_GAP_MS, redactSecret } from './client'
import { normaliseGetItems, stateFromReading, stateChanged, groupId } from './status'
import { planDeviceAction, isLiveOverride } from './plan'
import { rollDailyEnergy } from './energy'
import { AUTH_ERROR, HOST_ERROR } from './connections'
import { effectiveTarget, GROUP_COLUMNS } from './effective'
import { safetyTimersOn } from './safety-timers'
import { runShellyAlerts } from './alerts'

const MODULE = 'shelly-reconcile'

// A row's component kind (mig 775). Anything but 'light' is a switch: every row
// adopted before the column existed is a relay, and the column's CHECK admits
// only the two values, so the fallback only ever covers a row read without it.
export const deviceKind = (d) => (d?.kind === 'light' ? 'light' : 'switch')

// The spec's estate ceiling. Both selects ask for cap + 1 so "exactly at the
// cap" can be told from "the limit silently dropped the rest" — the same
// distinction sonos/reconcile.js warns about, made decidable rather than
// guessed.
export const MAX_CONNECTIONS = 100
export const MAX_DEVICES = 50
// SHELLYGROUPS.4 — groups a location can hold, read cap + 1 like the rest.
export const MAX_GROUPS = 50

// Read batch size comes FROM the client, never a hardcoded 10: the client
// refuses an over-long `get` outright (kind 'too_many_ids') rather than
// slicing, so a drift between the two numbers is a whole batch lost per tick.
export const READ_BATCH = MAX_GET_IDS

// How long a connection a human must fix is left alone. It is not a backoff —
// `action_needed` means the key or the host is wrong, and hammering a wrong key
// spends the account's whole 1 req/sec budget on a call that cannot succeed.
export const ACTION_NEEDED_RETRY_MS = 15 * 60_000

// The shorter brake, for a connection that is merely FAILING rather than
// misconfigured: an outage nobody has to fix, so it is retried far sooner — but
// not every 60 seconds, which for a black-holed host is 1,440 pointless
// requests a day out of an account budget its siblings are sharing.
export const ERROR_RETRY_MS = 5 * 60_000

// SHELLYALERTS — the alert pass is skipped when the sweep has less than this
// left: it makes no Shelly call, but it does make ledger round trips, and an
// alert the ledger has not claimed is simply sent on the next tick.
export const ALERT_DEADLINE_MARGIN_MS = 10_000

// Only used when `sleep` is not injected. The client keeps its own copy for its
// own pacing; this one is for the gap BETWEEN two locations of one account,
// which no single client can see.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// SHELLYTIMERS.2 — the relay's output as THIS tick read it, for the planner's
// re-arm guard (plan.js header): true / false only from a device that spoke
// and named this channel; anything else is null, "not known", which the
// planner never re-arms on. The row's stored last_state is NOT used — it is
// the previous tick's.
function relayOnFrom(reading, d) {
  if (!reading?.online) return null
  const out = stateFromReading(null, reading, d?.channel, '', deviceKind(d)).output
  return out === true ? true : out === false ? false : null
}

// The last_applied stamp for a command that landed. `cap_at` only when the
// command carried a timer: an absent cap_at is what "not armed" means.
export const appliedStamp = (p, atIso) => ({
  key: p.key, action: p.action, reason: p.reason, at: atIso, ...(p.capAt ? { cap_at: p.capAt } : {}),
})

// The energy carry window. rollDailyEnergy can only bank a gap into today while
// the caller still hands it the last row, so THIS WINDOW IS THE REACH of that
// promise (energy.js's fourth obligation spells it out). The row cap moves with
// the window by construction: MAX_DEVICES devices × (lookback + today) is every
// row the window can hold, and the product must stay under PostgREST's 1k
// ceiling — widen the window and the cap widens with it, no second edit.
export const ENERGY_LOOKBACK_DAYS = 7

// The ceiling the per-location limit can ever reach — every device at a full
// location, every day of the window. The select itself asks for the row count
// THIS location can actually produce (devices × days, + 1 sentinel), so a
// two-device studio reads two devices' rows rather than a fixed 400; this
// constant exists to pin that the worst case still clears PostgREST's 1k cap by
// a wide margin, and it moves with the window automatically.
export const ENERGY_ROW_CAP = MAX_DEVICES * (ENERGY_LOOKBACK_DAYS + 1)

// An explicit projection, never '*'. rollDailyEnergy's continuing-day branch
// spreads the row it is handed straight back into the bulk upsert, and
// supabase-js sends the UNION of every row's keys as `columns=` — so a column
// added to this table later would ride the round-trip into the upsert on the
// continuing rows and be written NULL on the new-day ones, silently, on the
// nightly rollover only. The list is the write shape; keep the two together.
const ENERGY_COLUMNS = 'device_id, location_id, day, wh_start, wh_last, wh_total, samples, resets, first_sample_at, last_sample_at'

// The most occurrences one location can hold in a day, several times over.
export const MAX_OCCURRENCES = 500

// Operator-facing, and deliberately fixed literals: they are stored in
// last_error and rendered in the UI, so nothing derived from a response body
// (which could carry the key) may reach them. DEFINED IN connections.js since
// SHELLY-UI.4b — the cron is no longer the only writer of these strings (the
// discover and adopt routes park the same dead key) — and re-exported here so
// every existing importer and test of reconcile.js is unaffected.

// Distinct from 'unreachable' on purpose: the account IS reachable, we are over
// its budget. Told the wrong one, an owner goes looking at their wifi.
export const RATE_LIMIT_ERROR = 'Shelly rate limit hit — over the 1 req/s account budget'

export { AUTH_ERROR, HOST_ERROR }

const COUNTER_KEYS = [
  'devices', 'reads', 'readFailures', 'rateLimited', 'stateWrites', 'energyWrites',
  'planned', 'applied', 'failed', 'authFailures', 'skippedClass', 'crashed',
  // A grouped device not planned this tick because its group could not be
  // read (or was not among the rows read). Never run on its own schedule.
  'skippedGroup',
  // A location the tick never got to. Counted separately from `crashed` because
  // it is the sweep's own budget talking, not the location failing — and from
  // `failed`, which means a command we owed and did not send.
  'deadlineSkipped',
]
const zeroCounters = () => Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]))
const addCounters = (into, from) => {
  for (const k of COUNTER_KEYS) into[k] += Number(from?.[k]) || 0
  return into
}

// Shelly device ids are MACs, and normaliseGetItem lowercases every one it
// returns. A stored id that differs only in case would therefore never match a
// reading — the device would read as absent from a successful batch and be
// written offline every minute. Compare on this, always; send the STORED
// spelling to the API.
const idKey = (v) => String(v ?? '').trim().toLowerCase()

// resolveTz is pure and does NOT log (see its header). Emitting the warning is
// the edge's job and this is the edge — without it a typo'd zone silently runs
// a studio on Dublin time, which is a support ticket nobody knows how to open.
//
// The test is validity, not "did the string change": 'europe/dublin' resolves to
// 'Europe/Dublin', which differs textually and is NOT a rejection. Warning on
// that would train the operator to ignore the warning that matters.
function locationTz(conn) {
  const raw = conn?.locations?.timezone
  const tz = resolveTz(raw)
  if (typeof raw === 'string' && raw.trim() !== '' && !isValidTz(raw)) {
    logWarn(MODULE, 'unknown location timezone — falling back to Dublin', {
      locationId: conn?.location_id, timezone: raw, using: tz,
    })
  }
  return tz
}

// The only write to shelly_connections in this file. Best-effort: a failed
// status write costs a stale badge, never a command, so it is logged and the
// tick carries on.
async function markConnection(db, conn, patch) {
  const { error } = await db.from('shelly_connections').update(patch).eq('id', conn.id)
  if (error) logWarn(MODULE, 'connection status write failed', { locationId: conn?.location_id, error: error.message })
}

/**
 * Today's live class occurrences for one location, bounded to the LOCATION's
 * local day. A thin wrapper over loadDayOccurrences for "the day `nowMs` falls
 * on" — the cron and run-now both mean today.
 *
 * @returns {{ok: true, occurrences: Array} | {ok: false, error: string}}
 */
export async function loadTodayOccurrences(db, locationId, tz, nowMs) {
  // dayStrInTz THROWS on an unreadable instant, by design. This function is
  // exported and PR 2's routes call it, so the clock is checked here rather
  // than trusting every future caller to have guarded first.
  if (!Number.isFinite(nowMs)) return { ok: false, error: 'unusable clock' }
  return loadDayOccurrences(db, locationId, tz, dayStrInTz(nowMs, tz))
}

/**
 * One LOCAL day's live class occurrences for one location (SHELLYGROUPS.5:
 * the day preview asks for a date that is not today).
 *
 * The end bound is the next local midnight resolved in the zone, never
 * start + 24h: on a DST day the local day is 23 or 25 hours long, and a flat
 * +24h either drops the last class of the day or pulls in tomorrow's first one.
 * `name` rides along for the preview's class lane; the engine ignores it.
 *
 * @param dayStr 'YYYY-MM-DD', the location's calendar day.
 * @returns {{ok: true, occurrences: Array} | {ok: false, error: string}}
 */
export async function loadDayOccurrences(db, locationId, tz, dayStr) {
  // strictDayStartMsIn answers null for a date that is not real (2026-02-30)
  // or not a date at all. Refused here, before the query, so a caller can
  // never bound a select by NaN.
  const startMs = /^\d{4}-\d{2}-\d{2}$/.test(String(dayStr ?? '')) ? dayStartMsInTz(dayStr, tz) : null
  const nextDay = startMs == null ? null : addDaysISO(dayStr, 1)
  const endMs = nextDay == null ? null : dayStartMsInTz(nextDay, tz)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, error: 'unusable day' }
  const start = new Date(startMs).toISOString()
  const end = new Date(endMs).toISOString()
  const { data, error } = await db
    .from('class_occurrences')
    .select('starts_at, ends_at, cancelled_at, name')
    .eq('location_id', locationId)
    .gte('starts_at', start)
    .lt('starts_at', end)
    .is('cancelled_at', null)
    .order('starts_at')
    // cap + 1, like every other select in this file: "exactly at the cap" and
    // "the limit dropped the rest" are different facts, and only the sentinel
    // row makes them decidable. Without it a truncated timetable is silent, and
    // a missing occurrence is a class whose window never opens.
    .limit(MAX_OCCURRENCES + 1)
  if (error) return { ok: false, error: error.message }
  const rows = data || []
  if (rows.length > MAX_OCCURRENCES) {
    logWarn(MODULE, 'occurrence cap exceeded, excess occurrences skipped this tick', { locationId, cap: MAX_OCCURRENCES })
    return { ok: true, occurrences: rows.slice(0, MAX_OCCURRENCES) }
  }
  return { ok: true, occurrences: rows }
}

/**
 * Steps 2 and 3 of a location's tick: batched reads, and the last_state writes
 * they justify. Split out because PR 2's POST /api/shelly/refresh runs exactly
 * this and nothing else.
 *
 * @param ctx {{ now?, sleep?, makeClient?, client?, deadlineAt?, nowMs? }}
 * @returns readings (Map keyed by lowercased device id), covered (Set of the ids
 *          a SUCCESSFUL batch spoke for), the client it built, and counters.
 */
export async function refreshLocationState(db, conn, devices, ctx = {}) {
  const now = ctx.now || Date.now
  // Infinity, not undefined: `now() > undefined` is false, which happens to
  // work, but writing the "no budget" case down is what stops the next reader
  // from adding a `?? 0` and disabling every read.
  const deadlineAt = Number.isFinite(ctx.deadlineAt) ? ctx.deadlineAt : Infinity
  const client = ctx.client || (ctx.makeClient || createShellyClient)(conn, { sleep: ctx.sleep, now })
  const tickMs = Number.isFinite(ctx.nowMs) ? ctx.nowMs : now()
  const nowIso = new Date(Number.isFinite(tickMs) ? tickMs : Date.now()).toISOString()
  const locationId = conn?.location_id

  // One read per DEVICE, not per row: a 4PM adopted on all four channels is
  // four rows and one device, and asking for its id four times would burn four
  // slots of a ten-wide batch on the same answer.
  const seen = new Set()
  const ids = []
  for (const d of devices) {
    const key = idKey(d?.device_id)
    if (!key || seen.has(key)) continue
    seen.add(key)
    ids.push(d.device_id)
  }

  const readings = new Map()
  const covered = new Set()
  // SHELLYALERTS.3 — what each row looks like AFTER this tick, for the alert
  // pass. Only rows whose write LANDED: a failed write leaves the stored row
  // as the truth.
  const fresh = new Map()
  let reads = 0
  let readFailures = 0
  let rateLimited = 0
  let stateWrites = 0
  let items = 0
  let auth = false
  let config = false
  let anyOk = false
  let lastKind = null
  let stalled = false
  // A call that FAILED for budget, as opposed to one the client's retry
  // absorbed. The counter above cannot answer this — it deliberately conflates
  // the two — and the connection status needs the distinction.
  let budgetHit = false
  let deadlineWarned = false

  for (let i = 0; i < ids.length; i += READ_BATCH) {
    if (now() > deadlineAt) {
      if (!deadlineWarned) {
        deadlineWarned = true
        logWarn(MODULE, 'time budget exhausted — reads stopped', { locationId, done: reads, remaining: ids.length - i })
      }
      break
    }
    const batch = ids.slice(i, i + READ_BATCH)
    const res = await client.get(batch)
    reads++
    // A `retried` success cost two requests and means the account is at its
    // budget — the same signal as an outright 429, and the only warning before
    // a same-account sibling starts failing. Counted once either way.
    if (res.retried || (!res.ok && res.kind === 'rate_limited')) rateLimited++
    if (!res.ok) {
      readFailures++
      lastKind = res.kind
      if (res.kind === 'rate_limited') budgetHit = true
      // Both mean every remaining batch would fail identically: a wrong key is
      // wrong for all ten batches, and a bad host never reaches the network.
      if (res.kind === 'auth') { auth = true; break }
      if (res.kind === 'config') { config = true; break }
      // NOTHING HAS SUCCEEDED YET, so this is not one batch being unlucky — it
      // is the account not answering. Every remaining batch would spend a slot
      // of the shared budget to learn the same thing, and so would the command
      // call after them. Stop, and tell the caller to skip the commands.
      // A failure AFTER a success is treated as the blip it probably is: the
      // loop carries on and the batches that do work are still written.
      // No kind is excluded: `get` never yields 'device' (that tag belongs to
      // the set/ endpoints), and every kind it CAN yield here — network, http,
      // rate_limited, and the two caller-bug tags — repeats identically on the
      // next batch.
      if (!anyOk) { stalled = true; break }
      continue
    }
    anyOk = true
    for (const id of batch) covered.add(idKey(id))
    for (const item of normaliseGetItems(res.body)) {
      readings.set(item.device_id, item)
      items++
    }
  }

  // An auth or host failure says nothing about any device's state — writing a
  // wall of offline rows off the back of a rejected key would be inventing a
  // fact from an unanswered question.
  if (!auth && !config) {
    for (const d of devices) {
      const key = idKey(d?.device_id)
      // Rule 2 of the header: only a batch that SUCCEEDED speaks for its ids.
      if (!covered.has(key)) continue
      // readings.get() may be undefined — the account answered and did not
      // mention this device, which stateFromReading reads as offline while
      // KEEPING the last known measurements.
      const next = stateFromReading(d.last_state, readings.get(key), d.channel, nowIso, deviceKind(d))
      if (!stateChanged(d.last_state, next)) continue
      const { error } = await db
        .from('shelly_devices')
        .update({
          last_state: next,
          updated_at: nowIso,
          // last_seen_at advances only on a device that actually spoke. An
          // offline row must not refresh it or "last seen" becomes "last
          // polled" and the staleness alert can never fire.
          ...(next.online ? { last_seen_at: nowIso } : {}),
        })
        .eq('id', d.id)
      if (error) logWarn(MODULE, 'device state write failed', { locationId, deviceId: d.id, error: error.message })
      else {
        stateWrites++
        fresh.set(d.id, { last_state: next, ...(next.online ? { last_seen_at: nowIso } : {}) })
      }
    }
  }

  // TWO SHAPES status.js was written against docs rather than a live account
  // (see its header): the v2 `online` field, and the id the response echoes
  // back. Each failure mode looks EXACTLY like a quiet gym from the database
  // side, so each gets its own line — but only on the tick the picture changes.
  //
  // The gate is "some affected device could have CHANGED state this tick".
  // Without it, a studio that really is dark overnight logs one of these every
  // minute until morning and the warning stops being read (header rule 6).
  //
  // A NEVER-READ device counts. `last_state == null` is the shape a row has
  // between adopt and its first successful read — and the first tick after
  // adopt is precisely when a wrong id echo or a wrong `online` field shows
  // up. Gating on `online === true` alone stayed silent through the one tick
  // that could have named the bug, while writing every new device offline.
  const couldHaveChanged = (match) => devices.some((d) => match(idKey(d?.device_id))
    && (d.last_state?.online === true || d.last_state == null))
  const unanswered = [...covered].filter((id) => !readings.has(id))
  if (anyOk && covered.size > 0 && unanswered.length === covered.size && couldHaveChanged((k) => covered.has(k))) {
    // Every id we asked about came back unmentioned. A location that had really
    // gone dark would still be LISTED, saying `online: false` — so this is the
    // response echoing ids we cannot match, not devices dropping off.
    logWarn(MODULE, 'covered ids returned no readings — check the v2 id echo', { locationId, asked: covered.size, items })
  } else if (anyOk && items > 0 && ![...readings.values()].some((r) => r.online) && couldHaveChanged((k) => readings.has(k))) {
    logWarn(MODULE, 'every device reads offline — check the v2 online field', { locationId, items })
  }

  return { readings, covered, fresh, client, nowIso, reads, readFailures, rateLimited, stateWrites, auth, config, anyOk, lastKind, stalled, budgetHit }
}

/**
 * The location's groups, read once per tick. cap + 1 like every select here:
 * over the cap is warned and the first MAX_GROUPS used, never silent.
 *
 * @returns {{ok: true, groups: Array} | {ok: false, error: string}}
 */
async function loadLocationGroups(db, locationId) {
  const { data, error } = await db
    .from('shelly_groups')
    .select(GROUP_COLUMNS)
    .eq('location_id', locationId)
    .order('sort_order')
    .order('name')
    .limit(MAX_GROUPS + 1)
  if (error) return { ok: false, error: error.message }
  const rows = data || []
  if (rows.length > MAX_GROUPS) {
    logWarn(MODULE, 'group cap exceeded, excess groups skipped this tick', { locationId, cap: MAX_GROUPS })
    return { ok: true, groups: rows.slice(0, MAX_GROUPS) }
  }
  return { ok: true, groups: rows }
}

/**
 * SHELLYGROUPS.4 — pair every device with what it is planned against.
 *
 * An ungrouped device is its own target and costs no read: a location with no
 * groups never queries shelly_groups. A grouped device follows effectiveTarget,
 * EXCEPT in the three cases below, and in none of them does it fall back to its
 * own row's schedule silently:
 *  • the groups read failed → every grouped device is skipped for the tick
 *    (its own schedule is not what staff set; running it could switch a room
 *    the group holds open). Ungrouped devices still run.
 *  • its group is not among the rows read (over the cap, or deleted between
 *    the two reads; ON DELETE SET NULL clears group_id by the next tick) →
 *    skipped, for the same reason.
 *  • its group sits at another location → the group is IGNORED (the DB
 *    forbids the mix; this is the last fence before a relay command) and the
 *    device runs on its own row, which is what effectiveTarget returns.
 *    Logged with ids only.
 */
async function resolveTargets(db, locationId, devices, nowMs, counters) {
  const grouped = devices.filter((d) => d.group_id != null)
  const ungrouped = (d) => ({ device: d, target: d })
  if (!grouped.length) return devices.map(ungrouped)

  const res = await loadLocationGroups(db, locationId)
  if (!res.ok) {
    counters.skippedGroup += grouped.length
    logWarn(MODULE, 'groups load failed — grouped devices skipped this tick', { locationId, skipped: grouped.length, error: res.error })
    return devices.filter((d) => d.group_id == null).map(ungrouped)
  }

  const groupsById = new Map(res.groups.map((g) => [g.id, g]))
  const targets = []
  let notLoaded = 0
  for (const d of devices) {
    if (d.group_id == null) { targets.push(ungrouped(d)); continue }
    const g = groupsById.get(d.group_id)
    if (!g) { notLoaded++; continue }
    if (g.location_id !== d.location_id) {
      logWarn(MODULE, 'group at another location — ignored', { locationId, deviceId: d.id, groupId: g.id })
      targets.push(ungrouped(d))
      continue
    }
    targets.push({ device: d, target: effectiveTarget(d, g, nowMs) })
  }
  if (notLoaded) {
    counters.skippedGroup += notLoaded
    logWarn(MODULE, 'group not loaded — grouped devices skipped this tick', { locationId, skipped: notLoaded })
  }
  return targets
}

/**
 * One location's whole tick. Never throws for a data-shaped reason; a genuine
 * crash is caught by the sweep, which logs it with the key redacted.
 *
 * @param ctx {{ now?, sleep?, makeClient?, loadOccurrences?, deadlineAt?, alerts? }} (alerts: SHELLYALERTS.3, defaults to runShellyAlerts)
 * @returns counters (never null — the sweep sums them)
 */
export async function reconcileLocation(db, conn, ctx = {}) {
  const now = ctx.now || Date.now
  const deadlineAt = Number.isFinite(ctx.deadlineAt) ? ctx.deadlineAt : Infinity
  const loadOccurrences = ctx.loadOccurrences || loadTodayOccurrences
  const locationId = conn?.location_id
  const counters = zeroCounters()

  const tz = locationTz(conn)
  const nowMs = now()
  // Computed ONCE for the whole location, and guarded here: a NaN clock makes
  // every override read as expired and every window inactive, which planDevice-
  // Action turns into a location-wide OFF (its header says so in full). dayStr-
  // InTz would throw on it first, but a clean skip beats a caught crash.
  if (!Number.isFinite(nowMs)) {
    logError(MODULE, 'unusable clock — location skipped', { locationId })
    return counters
  }
  const dateStr = dayStrInTz(nowMs, tz)

  // ---- 1. devices ---------------------------------------------------------
  const { data: deviceRows, error: deviceErr } = await db
    .from('shelly_devices')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at')
    .limit(MAX_DEVICES + 1)
  if (deviceErr) {
    logWarn(MODULE, 'device load failed', { locationId, error: deviceErr.message })
    return counters
  }
  let devices = deviceRows || []
  if (devices.length > MAX_DEVICES) {
    logWarn(MODULE, 'device cap exceeded, excess devices skipped this tick', { locationId, cap: MAX_DEVICES })
    devices = devices.slice(0, MAX_DEVICES)
  }
  // A location with nothing adopted costs no request and no write. The
  // connection is left exactly as it is: we learned nothing about it.
  if (!devices.length) return counters
  counters.devices = devices.length

  if (now() > deadlineAt) {
    counters.deadlineSkipped = 1
    logWarn(MODULE, 'time budget exhausted — location skipped', { locationId })
    return counters
  }

  // ---- 2 + 3. read, and store what changed --------------------------------
  const state = await refreshLocationState(db, conn, devices, {
    now, nowMs, sleep: ctx.sleep, makeClient: ctx.makeClient, deadlineAt,
  })
  const { client, nowIso, readings, stalled } = state

  // SHELLYALERTS.3 — the alert pass, LAST on every path that read: after the
  // state writes and the connection status. It pushes nothing to Shelly (no
  // budget spent) and it can never break this reconcile or the sweep: any
  // throw is logged with ids only (the message redacted of the key).
  //
  // Review fixes: skipped within ALERT_DEADLINE_MARGIN_MS of the sweep's
  // deadline (the ledger keeps the alert for the next tick), and device alerts
  // (offline, fault) are planned only when a read LANDED this tick: on a
  // refused key or a bad host nothing was learned about any device.
  const deviceAlerts = state.anyOk && !state.auth && !state.config
  const alertPass = async (keyRejected) => {
    try {
      if (now() > deadlineAt - ALERT_DEADLINE_MARGIN_MS) {
        logWarn(MODULE, 'alert pass skipped — time budget nearly spent', { locationId })
        return
      }
      const current = devices.map((d) => (state.fresh?.has(d.id) ? { ...d, ...state.fresh.get(d.id) } : d))
      await (ctx.alerts || runShellyAlerts)(db, {
        locationId, conn, devices: current, nowMs, tz, keyRejected, deviceAlerts, studioName: conn?.locations?.name ?? null,
      })
    } catch (e) {
      logWarn(MODULE, 'alert pass failed', { locationId, err: redactSecret(e, conn?.auth_key) })
    }
  }
  counters.reads = state.reads
  counters.readFailures = state.readFailures
  counters.rateLimited = state.rateLimited
  counters.stateWrites = state.stateWrites

  let anyOk = state.anyOk
  let lastKind = state.lastKind
  let auth = state.auth
  // A bad host discovered on the COMMAND path. Kept separate from `anyOk` so a
  // read that worked cannot mark a connection 'connected' on a tick whose
  // command was refused for a host the client would not even dial.
  let hostBad = false
  // Likewise for a hard 429 anywhere this tick. A read succeeding proves the
  // account is REACHABLE, which is not the same as our commands landing — and a
  // studio whose relays did not move must not be showing a green badge. It also
  // leaves last_ok_at unadvanced, which puts this connection at the front of the
  // next sweep's rotation, exactly where a location losing commands belongs.
  let budgetHit = state.budgetHit
  // Whether we made (or tried to make) an HTTP call at all. Header rule 5: with
  // no attempt there is no evidence, so the connection status is not touched.
  let attempted = state.reads > 0

  if (auth) {
    counters.authFailures = 1
    await markConnection(db, conn, { status: 'action_needed', last_error: AUTH_ERROR, last_error_at: nowIso, updated_at: nowIso })
    await alertPass(true)
    return counters
  }
  if (state.config) {
    // Unreachable for a persisted row (the host column carries a CHECK), but
    // handled anyway — and NOT as 'error', which would retry a malformed host
    // forever. action_needed is the state that says "a human must retype this".
    await markConnection(db, conn, { status: 'action_needed', last_error: HOST_ERROR, last_error_at: nowIso, updated_at: nowIso })
    // A bad host is not a rejected key: no key alert, the device alerts only.
    await alertPass(false)
    return counters
  }

  // ---- 4. energy ----------------------------------------------------------
  // Scoped to THESE devices, projected to the write shape, newest day first.
  // Each of those matters: `.in` keeps a location's read proportional to what it
  // adopted instead of a flat 400-row scan, the projection is the upsert's
  // column contract (see ENERGY_COLUMNS), and the ordering means that if the cap
  // ever does truncate it drops the OLDEST rows — the per-device baseline this
  // step actually needs survives.
  const energyExpected = devices.length * (ENERGY_LOOKBACK_DAYS + 1)
  const { data: energyRows, error: energyErr } = await db
    .from('shelly_energy_daily')
    .select(ENERGY_COLUMNS)
    .eq('location_id', locationId)
    .in('device_id', devices.map((d) => d.id))
    .gte('day', addDaysISO(dateStr, -ENERGY_LOOKBACK_DAYS))
    .lte('day', dateStr)
    .order('day', { ascending: false })
    .limit(energyExpected + 1)
  if (energyErr) {
    // The roll is SKIPPED, not run against an empty baseline. rollDailyEnergy
    // with no prevRow opens a fresh day (samples 1, wh_total 0), and the upsert
    // REPLACES the row — so continuing here would wipe the day's accumulated
    // total for every device at the location. Losing one minute's sample is a
    // rounding error; losing the day is data.
    logWarn(MODULE, 'energy load failed — energy not rolled this tick', { locationId, error: energyErr.message })
  } else {
    // NOTE THE TWO DIFFERENT IDS on the next few lines: `latest` is keyed on
    // shelly_energy_daily.device_id, which is the shelly_devices.id UUID (the
    // FK), while `readings` is keyed on shelly_devices.device_id, the Shelly
    // MAC. Same column name, different id space.
    // The + 1 row is a sentinel: more rows than this location can possibly own
    // means the window returned something we cannot account for, and the
    // baseline might be the row that got dropped. Decidable, not guessed.
    if ((energyRows || []).length > energyExpected) {
      logWarn(MODULE, 'energy window returned more rows than this location can own', { locationId, expected: energyExpected })
    }
    const latest = new Map()
    for (const r of energyRows || []) {
      const cur = latest.get(r.device_id)
      // PostgREST returns a `date` as 'YYYY-MM-DD', which compares correctly as
      // a string; the slice keeps that true for a timestamp-shaped or
      // Date-hydrated value rather than letting it sort as "later than
      // everything".
      if (!cur || String(cur.day).slice(0, 10) < String(r.day).slice(0, 10)) latest.set(r.device_id, r)
    }

    const upserts = []
    for (const d of devices) {
      const reading = readings.get(idKey(d.device_id))
      // energy.js's third obligation: sample ONLY an online device. An offline
      // row holds a frozen counter, and differencing it books zero consumption
      // over a gap we never measured.
      if (!reading?.online) continue
      // Channel AND kind (SHELLYLIGHT.3): `light:0` and `switch:0` are
      // different components, and a row must only ever sample its own.
      const kind = deviceKind(d)
      const channel = (Array.isArray(reading.channels) ? reading.channels : [])
        .find((c) => c?.channel === d.channel && (c?.kind ?? 'switch') === kind)
      const total = channel?.aenergy_wh
      // Not a metering channel, or the measurement was momentarily absent.
      // status.js already guarantees null-or-finite here; the test is explicit
      // so a future shape change cannot slip a string through.
      if (typeof total !== 'number' || !Number.isFinite(total)) continue
      const next = rollDailyEnergy(latest.get(d.id) || null, { total_wh: total, at: nowIso }, dateStr)
      if (!next) continue
      // UNCONDITIONALLY, per energy.js's first obligation: the new-day branch
      // returns a clean literal that carries neither id.
      upserts.push({ ...next, device_id: d.id, location_id: locationId })
    }

    if (upserts.length) {
      const { error } = await db.from('shelly_energy_daily').upsert(upserts, { onConflict: 'device_id,day' })
      if (error) logWarn(MODULE, 'energy upsert failed', { locationId, rows: upserts.length, error: error.message })
      else counters.energyWrites = upserts.length
    }
  }

  // ---- 5. plan ------------------------------------------------------------
  if (stalled) logWarn(MODULE, 'no read succeeded — commands skipped this tick', { locationId, kind: lastKind })

  // SHELLYGROUPS.4 — what each device is judged against. A black-holed account
  // is planned for but not commanded (header rule 6), so with `stalled` there
  // is nothing to resolve and no group read is spent on it.
  const targets = stalled ? [] : await resolveTargets(db, locationId, devices, nowMs, counters)

  let occurrences = []
  let classOk = true
  // The EFFECTIVE schedule decides: a member of a class-mode group needs the
  // timetable even when its own row says 'fixed' or 'none'.
  if (targets.some(({ target: t }) => t.enabled && t.schedule_mode === 'class')) {
    const res = await loadOccurrences(db, locationId, tz, nowMs)
    if (res.ok) occurrences = res.occurrences
    else {
      classOk = false
      logWarn(MODULE, 'occurrence load failed — class devices skipped this tick', { locationId, error: res.error })
    }
  }

  const plans = []
  // SHELLYTIMERS.5 — off unless the studio switched it on.
  const timers = safetyTimersOn(conn?.locations?.safety_timers)
  // A black-holed account is planned for but not commanded (header rule 6):
  // iterating nothing leaves `planned` at 0, so the counters never claim work
  // that was never attempted, and no stamp is written for a command not sent.
  for (const { device: d, target: t } of targets) {
    // With no timetable, a class device's windows resolve empty and rule 4
    // would CLOSE anything we had opened — a failed select would switch the
    // studio off. Skipping is the fail-open. A LIVE override is exempt: a
    // manual action does not depend on the timetable, and rule 1 returns
    // before the planner ever looks at a window. isLiveOverride is imported
    // rather than re-derived so a stale, expired override cannot defeat the
    // skip by merely existing.
    // Judged on the EFFECTIVE target: the group's mode, and the override that
    // won (device over group), so a live group override is exempt too.
    if (t.enabled && t.schedule_mode === 'class' && !classOk && !isLiveOverride(t.override, nowMs)) {
      counters.skippedClass++
      continue
    }
    const plan = planDeviceAction(t, nowMs, dateStr, occurrences, tz, {
      relayOn: relayOnFrom(readings.get(idKey(d.device_id)), d),
      timers,
    })
    // The DEVICE row rides on: its id is what gets stamped, its device_id and
    // channel are what gets commanded. effectiveTarget keeps those (and the
    // device's own last_applied) unchanged, so the planner and the stamp agree.
    if (plan) plans.push({ device: d, ...plan })
  }
  counters.planned = plans.length

  // ---- 6. command, then stamp --------------------------------------------
  // One call per direction per TIMER: every closing device in one setGroups,
  // and the opening devices in one setGroups per distinct safety cap
  // (SHELLYTIMERS.2 — set/groups carries ONE toggle_after per call, and
  // plan.js rounds caps to the minute so the devices of one window share
  // one). Unarmed opens (an unmanaged target's override) are their own batch.
  // `on` first — a window that opens and one that closes in the same tick
  // should light the room before it darkens the other.
  // Each call carries both kinds (SHELLYLIGHT.3): `{ switch: [...], light: [...] }`
  // in ONE request, so a studio with lights spends no extra slot for them.
  // failedCommands keys stay `<id>_<channel>` for both kinds, and a switch and
  // a light never share an id and channel (mig 775), so one gid set reads both.
  const batches = []
  for (const on of [true, false]) {
    const wanted = plans.filter((p) => p.action === (on ? 'on' : 'off'))
    // An off never carries a timer (the planner never emits one on an off).
    const byTimer = on ? Map.groupBy(wanted, (p) => p.toggleAfterSec ?? null) : new Map([[null, wanted]])
    for (const [toggleAfterSec, group] of byTimer) if (group.length) batches.push({ on, toggleAfterSec, wanted: group })
  }

  for (const { on, toggleAfterSec, wanted } of batches) {
    const batch = []
    for (const p of wanted) {
      let gid
      try {
        gid = groupId(p.device)
      } catch {
        // groupId throws on a row with no id or a non-integer channel, on
        // purpose (see status.js). Caught HERE rather than let out: one
        // malformed row would otherwise crash this location every minute
        // forever, taking every healthy device with it. Still loud, still
        // counted as a failure — just not fatal to its neighbours.
        counters.failed++
        logWarn(MODULE, 'unusable device row — no group id', { locationId, deviceId: p.device?.id })
        continue
      }
      batch.push({ ...p, gid })
    }
    if (!batch.length) continue

    if (now() > deadlineAt) {
      // Not stamped, so the next tick re-plans them. Counted as failed because
      // that is what they are: a command this tick owed and did not send.
      counters.failed += batch.length
      logWarn(MODULE, 'time budget exhausted — commands dropped', { locationId, dropped: batch.length, on })
      break
    }

    attempted = true
    const groups = {
      switch: batch.filter((x) => deviceKind(x.device) === 'switch').map((x) => x.gid),
      light: batch.filter((x) => deviceKind(x.device) === 'light').map((x) => x.gid),
    }
    const res = toggleAfterSec == null
      ? await client.setGroups(groups, on)
      : await client.setGroups(groups, on, { toggleAfterSec })
    // Symmetric with the read path: a retried success and an outright 429 are
    // the same signal about the account's budget, counted once either way.
    if (res.retried || (!res.ok && res.kind === 'rate_limited')) counters.rateLimited++
    if (!res.ok) {
      if (res.kind === 'rate_limited') budgetHit = true
      // Includes kind 'device': a 2xx body carrying a top-level error means the
      // WHOLE batch failed (the client says so), not that some of it landed.
      counters.failed += batch.length
      lastKind = res.kind
      // `code` is Shelly's error string (truncated by the client); null when
      // the body carried none. SHELLYERR.1.
      logWarn(MODULE, 'command batch failed', {
        locationId, kind: res.kind, code: res.code ?? null, statusCode: res.statusCode ?? null, count: batch.length, on,
        toggleAfterSec: toggleAfterSec ?? null,
      })
      if (res.kind === 'auth') { auth = true; break }
      if (res.kind === 'config') { hostBad = true; break }
      continue
    }
    anyOk = true
    // THE STAMP IS NEVER WRITTEN BY ABSENCE. Everything below reads "this gid
    // is not in res.failed" as "this relay moved" — which is only true while
    // res.failed is keyed the way we key our own gids. A response that keys it
    // any other way (ids without the channel suffix, an id space we do not
    // recognise) would mark the WHOLE batch applied precisely when the whole
    // batch may have failed, and the stamp costs the window: the planner sees
    // its own key already applied and never retries. One unrecognised key is
    // enough to distrust the map, so the batch is counted failed and stamped
    // nothing — the same command is idempotent and re-issued next tick.
    const gids = new Set(batch.map((x) => x.gid))
    const stray = Object.keys(res.failed || {}).find((k) => !gids.has(k))
    if (stray !== undefined) {
      counters.failed += batch.length
      // Truncated, and ONE key rather than the map: this comes out of a
      // response body, and a body is never logged verbatim in this file.
      logWarn(MODULE, 'failedCommands keyed in an unrecognised shape — batch not stamped', {
        locationId, sample: String(stray).slice(0, 64),
      })
      continue
    }
    for (const x of batch) {
      const code = res.failed?.[x.gid]
      if (code !== undefined) {
        counters.failed++
        // Truncated: `code` comes out of a response body, and a body is never
        // logged verbatim anywhere in this file.
        logWarn(MODULE, 'command failed', { locationId, deviceId: x.device.id, code: String(code).slice(0, 64) })
        continue
      }
      const { error } = await db
        .from('shelly_devices')
        .update({ last_applied: appliedStamp(x, nowIso), updated_at: nowIso })
        .eq('id', x.device.id)
      if (error) {
        // The relay DID move; only the stamp failed. Next tick re-plans the same
        // key and re-issues the same idempotent command, which is why counting
        // this as a failure is safe rather than a double-switch.
        counters.failed++
        logWarn(MODULE, 'last_applied write failed', { locationId, deviceId: x.device.id, error: error.message })
        continue
      }
      counters.applied++
    }
  }

  // ---- 7. connection status ----------------------------------------------
  if (auth) {
    counters.authFailures = 1
    await markConnection(db, conn, { status: 'action_needed', last_error: AUTH_ERROR, last_error_at: nowIso, updated_at: nowIso })
  } else if (hostBad) {
    await markConnection(db, conn, { status: 'action_needed', last_error: HOST_ERROR, last_error_at: nowIso, updated_at: nowIso })
  } else if (anyOk && !budgetHit) {
    // last_error_at is cleared WITH last_error, never left behind. The two are
    // one fact, and the sweep's park windows are computed from the timestamp
    // (`startedAt - Date.parse(last_error_at)`): a recovered connection that
    // keeps its old stamp shows an error time next to a green badge, and the
    // first tick it fails again is measured from a failure that already healed.
    await markConnection(db, conn, { status: 'connected', last_ok_at: nowIso, last_error: null, last_error_at: null, updated_at: nowIso })
  } else if (attempted) {
    // `kind` only — never a body, never a statusCode dressed up as prose. Rate
    // limiting gets its own sentence because "unreachable" would send an owner
    // to look at their wifi for a problem that is ours.
    await markConnection(db, conn, {
      status: 'error',
      last_error: budgetHit ? RATE_LIMIT_ERROR : `Shelly unreachable (${lastKind || 'unknown'})`,
      last_error_at: nowIso,
      updated_at: nowIso,
    })
  }

  await alertPass(auth)
  return counters
}

/**
 * The whole sweep. Never throws: a crash in one location is logged (key
 * redacted) and the rest still run.
 *
 * @returns {{ok: true, locations, parked, elapsedMs, ...counters} | {ok: false, reason?: string}}
 */
export async function runShellyReconcile(db, deps = {}) {
  const {
    now = Date.now,
    sleep,
    makeClient = createShellyClient,
    loadOccurrences = loadTodayOccurrences,
    budgetMs = 90_000,
    concurrency = 4,
    alerts,
  } = deps

  const startedAt = now()
  if (!Number.isFinite(startedAt)) {
    // Everything downstream is clock arithmetic. Refusing the tick outright is
    // the only answer that cannot switch a studio off on a NaN.
    logError(MODULE, 'unusable clock — sweep abandoned')
    return { ok: false, reason: 'bad_clock' }
  }
  const deadlineAt = startedAt + budgetMs

  const { data, error } = await db
    .from('shelly_connections')
    // The safety-timer switch rides as ONE json path (SHELLYTIMERS.5): never
    // `settings` itself, which holds the location's credentials.
    // (A literal, not SAFETY_TIMERS_SELECT interpolated, so check:select-columns
    // can read it.)
    // `name` (SHELLYALERTS.3) is the studio name an alert push carries.
    .select('id, location_id, host, auth_key, auth_key_fingerprint, status, last_ok_at, last_error_at, locations(timezone, safety_timers:settings->shelly->safety_timers, name)')
    // ROTATION, not registration order: whoever has gone longest without a
    // successful tick goes first, so when the budget runs short the shortfall
    // moves around the estate instead of always landing on the same tail.
    // created_at breaks ties so the order is still deterministic.
    .order('last_ok_at', { ascending: true, nullsFirst: true })
    .order('created_at')
    .limit(MAX_CONNECTIONS + 1)
  if (error) {
    logWarn(MODULE, 'connection load failed', { error: error.message })
    return { ok: false }
  }
  let rows = data || []
  // Dormant, not broken: the rows ARE the configuration, so no rows means no
  // studio has linked a Shelly account yet. Nothing is logged for it.
  if (!rows.length) return { ok: true, locations: 0 }
  if (rows.length > MAX_CONNECTIONS) {
    logWarn(MODULE, 'connection cap exceeded, excess locations skipped this tick', { cap: MAX_CONNECTIONS })
    rows = rows.slice(0, MAX_CONNECTIONS)
  }

  const active = []
  let parked = 0
  for (const c of rows) {
    const since = startedAt - Date.parse(c.last_error_at ?? '')
    // NaN loses every comparison, which is exactly the answer wanted here: a row
    // that cannot say when it broke is NOT parked, so an absent or unreadable
    // last_error_at can never strand a connection forever.
    // Two windows, because the two states mean different things — 'action_needed'
    // waits on a human, 'error' waits on the world.
    if (c.status === 'action_needed' && since < ACTION_NEEDED_RETRY_MS) { parked++; continue }
    if (c.status === 'error' && since < ERROR_RETRY_MS) { parked++; continue }
    active.push(c)
  }

  // ONE GROUP PER SHELLY ACCOUNT. A blank or missing fingerprint folds into a
  // single shared group on purpose: not knowing which account a row belongs to
  // must never license running it in parallel with one it might share a budget
  // with. Slow is recoverable, a 429 storm is not.
  const groups = [...Map.groupBy(active, (c) => String(c.auth_key_fingerprint ?? '')).values()]
  const ctx = { now, sleep, makeClient, loadOccurrences, deadlineAt, alerts }
  const totals = zeroCounters()

  const sleepFn = sleep || realSleep
  const results = await mapWithConcurrency(groups, concurrency, async (conns) => {
    const acc = zeroCounters()
    // SERIAL within the group — see the header. Do not turn this into a
    // Promise.all; the client's pacer is per-instance and cannot see siblings.
    for (let i = 0; i < conns.length; i++) {
      const c = conns[i]
      // HAND THE BUDGET OVER PROPERLY. The client this location is about to
      // build starts life believing it has never called, so without this gap its
      // first request lands milliseconds behind the previous location's last
      // one and buys a guaranteed 429 + retry, on every handoff, forever.
      //
      // Not past the deadline though: every remaining location is about to skip
      // itself anyway, and sleeping a second each to hand over a budget nobody
      // will spend just makes an overrunning tick overrun by longer.
      if (i > 0 && now() <= deadlineAt) await sleepFn(MIN_GAP_MS)
      try {
        addCounters(acc, await reconcileLocation(db, c, ctx))
      } catch (e) {
        acc.crashed++
        logError(MODULE, 'location reconcile crashed', { locationId: c.location_id, err: redactSecret(e, c.auth_key) })
      }
    }
    return acc
  })

  // Indexed, because results are returned in input order and the group's own key
  // is what a crash message has to be redacted against.
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r?.ok) addCounters(totals, r.value)
    // The worker body is fully guarded, so this is belt-and-braces — but a lost
    // group must still be visible rather than silently absent from the totals.
    else { totals.crashed++; logError(MODULE, 'connection group crashed', { err: redactSecret(r?.error, groups[i]?.[0]?.auth_key) }) }
  }

  const endedAt = now()
  return {
    ok: true,
    locations: active.length,
    parked,
    ...totals,
    elapsedMs: Number.isFinite(endedAt) ? endedAt - startedAt : 0,
  }
}

/**
 * Force one device to its scheduled state right now. Used by the run-now button
 * and by switching a device back to 'auto' — both mean "stop waiting for the
 * next tick and make the relay agree with the schedule".
 *
 * `deps.group` (SHELLYGROUPS.4, optional): the device's shelly_groups row. When
 * given, the device is planned through effectiveTarget exactly as the cron
 * plans it; omitted (every caller before groups), behaviour is unchanged. A
 * group at another location is ignored, logged with ids only.
 *
 * @returns {{ok: true, action, reason} | {ok: true, noop: true} | {ok: false, kind, ...}}
 */
export async function runNowForDevice(db, conn, device, deps = {}) {
  const {
    now = Date.now,
    makeClient = createShellyClient,
    loadOccurrences = loadTodayOccurrences,
    sleep,
    group = null,
  } = deps

  const tz = locationTz(conn)
  const nowMs = now()
  if (!Number.isFinite(nowMs)) return { ok: false, kind: 'bad_clock' }
  const dateStr = dayStrInTz(nowMs, tz)

  // The same guard the cron applies through groupId, for the same reason: a row
  // with no id or a non-integer channel would be sent as a command no device can
  // match, and the 2xx that came back would be stamped as applied.
  //
  // FIRST, ahead of the planner: a malformed row must answer `bad_device`, not
  // the `noop` it would get for schedule_mode 'none' — the operator needs to
  // know the row is broken, not that there was nothing to do. It also spares
  // the timetable read a device we could never command.
  if (!device?.device_id || !Number.isInteger(device?.channel)) return { ok: false, kind: 'bad_device' }

  let target = device
  if (group) {
    if (group.id !== device.group_id) {
      // A group handed in for a device that does not follow it (a stale read,
      // a caller bug) must not run the device on another group's schedule.
      logWarn(MODULE, 'group is not the device’s own — ignored', {
        locationId: conn?.location_id, deviceId: device.id, groupId: group.id, deviceGroupId: device.group_id ?? null,
      })
    } else if (group.location_id !== device.location_id) {
      logWarn(MODULE, 'group at another location — ignored', { locationId: conn?.location_id, deviceId: device.id, groupId: group.id })
    } else {
      target = effectiveTarget(device, group, nowMs)
    }
  }

  let occurrences = []
  if (target.enabled && target.schedule_mode === 'class') {
    const res = await loadOccurrences(db, conn?.location_id, tz, nowMs)
    // A forced action off an empty timetable would be an OFF the operator did
    // not ask for. Refuse and say why instead.
    if (!res.ok) return { ok: false, kind: 'occurrences', error: res.error }
    occurrences = res.occurrences
  }

  // force: the planner answers even when its own stamp says this key was
  // already applied — that is the entire point of the button.
  const plan = planDeviceAction(target, nowMs, dateStr, occurrences, tz, {
    force: true, timers: safetyTimersOn(conn?.locations?.safety_timers),
  })
  if (!plan) return { ok: true, noop: true }

  const client = makeClient(conn, { sleep, now })
  // A light is addressed through set/light; set/switch would name a component
  // the device does not have. An armed `on` (SHELLYTIMERS.2) carries its
  // safety cap; an off, or an unmanaged target's on, carries none.
  const timer = plan.toggleAfterSec ? [{ toggleAfterSec: plan.toggleAfterSec }] : []
  const res = deviceKind(device) === 'light'
    ? await client.setLight(device.device_id, device.channel, plan.action === 'on', ...timer)
    : await client.setSwitch(device.device_id, device.channel, plan.action === 'on', ...timer)
  if (!res.ok) {
    return { ok: false, kind: res.kind, code: res.code ?? null, statusCode: res.statusCode ?? null, permanent: res.permanent === true }
  }

  const nowIso = new Date(nowMs).toISOString()
  const { error } = await db
    .from('shelly_devices')
    .update({ last_applied: appliedStamp(plan, nowIso), updated_at: nowIso })
    .eq('id', device.id)
  // Best-effort: the relay has already moved, and reporting failure would tell
  // the operator the switch did not happen when it did.
  if (error) logWarn(MODULE, 'run-now stamp write failed', { deviceId: device?.id, error: error.message })

  return { ok: true, action: plan.action, reason: plan.reason }
}
