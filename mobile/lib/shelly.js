// mobile/lib/shelly.js
// SHELLY-MOB.1 — the pure half of the mobile Smart plugs screen.
//
// React-free and RN-free ON PURPOSE. mobile/lib/**/*.test.js runs under the
// repo's vitest in a Node environment, so anything imported here that pulled in
// react-native — or ./api, which reaches expo-constants and the supabase client
// — would take this file's own tests out of the glob. The screen does the IO;
// this file does the judging, and every branch below is pinned by shelly.test.js.
//
// Everything here is a MOBILE RE-TYPING of a decision the web surface already
// made, because mobile cannot import src/lib (CLAUDE.md, Web/mobile boundary).
// Each one names its web original so the pair can be moved together.

import {
  addDaysISO, formatInZone, instantToZonedParts, nextLocalMidnightMs, resolveZone, strictDayStrIn, timeLabelIn,
} from 'shared/zoned-time'

// ── Freshness thresholds ────────────────────────────────────────────────────
// Re-typed from src/lib/shelly/device-health.js (HEALTH_FRESH_MS /
// HEALTH_STALE_MS). The fresh window is the ENGINE'S WRITE FLOOR PLUS ONE
// MISSED SWEEP, not its read cadence: reconcile.js reads every adopted device
// once a minute but only writes a row — and only then does `last_seen_at`
// advance — when something moved, and an idle plug is deadband-stable by
// design, so its row is rewritten only on STATE_REFRESH_MS (5 min,
// src/lib/shelly/status.js). A shorter window flickers amber on healthy
// hardware for two minutes out of every five, which is exactly the noise that
// teaches an operator to ignore the chip.
//
// THESE NUMBERS AND THE WEB'S ARE ONE FACT, NOT TWO. Raise STATE_REFRESH_MS on
// the web and this file has to move with it in the same change, or the flicker
// this sizing exists to prevent comes back here instead.
export const PLUG_FRESH_MS = 5 * 60_000 + 60_000
export const PLUG_STALE_MS = 15 * 60_000

// The light-theme recipe from CLAUDE.md (text on a light card needs the -700
// ramp). Kept beside the grader for the same reason the web keeps
// HEALTH_TONE_CLASSES there: a new tone cannot be returned without something to
// render it in. The dot is a hex because it is a `style` backgroundColor on a
// plain <View>, not a class.
export const PLUG_TONE_TEXT = Object.freeze({
  green: 'text-emerald-700',
  amber: 'text-amber-700',
  red: 'text-red-700',
  grey: 'text-un1t-subtle',
})
export const PLUG_TONE_DOT = Object.freeze({
  green: '#10B981',
  amber: '#F59E0B',
  red: '#DC2626',
  grey: '#94A3B8',
})

const GREY = (label, reason) => ({ tone: 'grey', label, reason })

/**
 * How fresh is what the row is showing?
 *
 * Re-typed from `deviceHealth` in src/lib/shelly/device-health.js, INCLUDING
 * the order of the first two checks, neither of which is about the device:
 *
 *   1. `connected === false` WINS OVER EVERYTHING. After a deliberate
 *      Disconnect on the web the rows stay adopted (deleting them would cascade
 *      the energy history away), so `last_seen_at` simply stops advancing. A
 *      grader that started from staleness would paint every row red within a
 *      quarter of an hour and point the operator at a connection they removed
 *      on purpose. No connection means DORMANT, not broken.
 *
 *   2. `connected === null` NEVER REACHES RED. That is the third state
 *      GET /api/shelly/devices answers with (`connection_status: 'unknown'`)
 *      when the device list read fine and the connection row did not. Grading a
 *      live studio "Stale" off a database blip on OUR side would invent a fault
 *      in THEIR hardware, so the age still shows (it is a true fact about the
 *      last reading) but the verdict caps at amber. `undefined` is treated the
 *      same: a caller that has not resolved the flag yet must not get a
 *      confident answer either.
 *
 * @param {object} device   a shelly_devices row as GET /api/shelly/devices sends it
 * @param {boolean|null|undefined} connected  that response's `connected` flag
 * @param {number} [nowMs]  testable clock
 * @returns {{tone:'grey'|'green'|'amber'|'red', label:string, reason:string}}
 */
export function plugTone(device, connected, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()

  // (1) — before anything about the device itself.
  if (connected === false) return GREY('Not connected', 'not_connected')

  // (2) — uncertain connection: no red below, whatever the age says.
  const uncertain = connected === null || connected === undefined

  const seenMs = Date.parse(device?.last_seen_at ?? '')
  const hasSeen = Number.isFinite(seenMs)

  if (!hasSeen) {
    // With no reading AND no connection answer there is nothing to report but
    // the uncertainty itself — "waiting for its first status" would blame the
    // plug for a read that failed on our side.
    return uncertain
      ? GREY('Connection unknown', 'connection_unknown')
      : GREY('Waiting for first status', 'never_seen')
  }

  // A fact from the reading rather than an inference from a clock, so it
  // outranks the age below and stays grey — an offline plug is a normal
  // overnight state, not a fault.
  if (device?.last_state?.online === false) return GREY('Offline', 'offline')

  const ageMs = now - seenMs
  if (ageMs <= PLUG_FRESH_MS) return { tone: 'green', label: 'Online', reason: 'fresh' }

  // Never 0: an age of just over the fresh window rounds to 6, and anything
  // that rounded to "Last seen 0 min ago" would read as a bug.
  const mins = Math.max(1, Math.round(ageMs / 60_000))
  if (ageMs <= PLUG_STALE_MS) {
    return { tone: 'amber', label: `Last seen ${mins} min ago`, reason: 'lagging' }
  }
  if (uncertain) {
    return { tone: 'amber', label: `Last seen ${mins} min ago`, reason: 'lagging_unverified' }
  }
  return { tone: 'red', label: 'Stale — check the Shelly connection', reason: 'stale' }
}

/**
 * The relay as a sentence, with its wattage when there is one.
 *
 * TWO RULES FROM THE BACKEND, both re-typed rather than paraphrased:
 *
 *   • `last_state.output === null` IS "UNKNOWN", NEVER "OFF" (rule 1 of
 *     src/components/automations/ShellyDeviceCard.jsx). An offline plug reports
 *     nothing about its relay, and mig 562's column comment makes every writer
 *     write the full seven-field shape precisely so the null survives. Printing
 *     "Off" for it tells an operator a heater is safe when nobody knows.
 *
 *   • ABSENT IS NOT ZERO (status.js rule 1). `apower` is nulled deliberately
 *     after a manual switch — a set/switch measures nothing, so carrying the
 *     previous watts forward under a fresh timestamp would render a stale
 *     number as a live measurement. A non-number therefore renders no wattage
 *     at all rather than "0 W".
 *
 * @param {object} device
 * @returns {string} e.g. 'On · 42 W', 'Off', 'Unknown'
 */
export function plugStateLabel(device) {
  const state = device?.last_state || {}
  const word = state.output === true ? 'On' : state.output === false ? 'Off' : 'Unknown'
  if (!Number.isFinite(state.apower)) return word
  return `${word} · ${Math.round(state.apower)} W`
}

// OUR words for a command that has not landed yet, keyed by the toggle route's
// own `code`. Every entry starts with "Queued" because that is the fact: the
// override is written BEFORE the command is sent, and the cron applies a live
// override to every adopted device, enabled or not — so this is a delay, not a
// loss. The route's own `message` is preferred over these when it sent one (it
// is written against the exact failure it saw); these are the fallback, and
// they point at the web CRM because that is where the fixes live on mobile.
const QUEUED_COPY = Object.freeze({
  pending: 'Queued — the plug will follow when it is back online.',
  key_rejected: 'Queued — re-paste the Shelly key on the web CRM and the plug will follow.',
  rate_limited: 'Queued — Shelly is busy right now; the plug will follow within a minute.',
  bad_host: 'Queued — fix the Shelly server on the web CRM and the plug will follow.',
})

// An unmanaged device (`enabled:false` or `schedule_mode:'none'`) answers
// `holds_until_changed: true`: plan.js rule 2 returns before rule 4 can close
// anything, so an expired override is never undone and the relay stays exactly
// as set. That is the approved v1 behaviour, and a countdown rendered beside one
// would be a promise the engine never intended to keep — so the sentence says
// what actually happens instead of naming a time.
export const HOLDS_TEXT = 'Stays as set — no schedule runs this plug'

/**
 * Has the relay NOT moved yet?
 *
 * `pending: true` is the route's own flag. The second arm exists because
 * mobile's api() FLATTENS the one pending body that arrives with a non-2xx
 * status: a rate limit answers HTTP 429 with `success: true, pending: true` in
 * the body (the 429 is a back-off signal so the client stops re-pressing, not a
 * failure), and api()'s "non-2xx without our standard envelope" branch replaces
 * that body with `{ success:false, status, error:'HTTP 429' }`. Without this
 * arm mobile would tell an operator their switch failed when it is saved and
 * will apply within the minute.
 *
 * Read by FIELD, never by matching api()'s error string — that is the regex
 * coupling GEOFENCE-TRANSPORT.1 removed, and it stops matching the day someone
 * rewords the message. `transport` is excluded deliberately: api() tags its
 * OWN envelopes with it, so a 429 whose body could not even be parsed is an
 * unreadable answer, not a queued command.
 *
 * @param {object|null} json  an api() result for POST /api/shelly/devices/<id>/toggle
 */
export function isQueued(json) {
  // The route's own field, end to end: since SHELLY-MOB.1 api() passes a
  // non-2xx body that carries our envelope through UNCHANGED, so the 429
  // pending answer arrives with `pending: true` intact. An envelope-less 429
  // (an edge page api() synthesised) is NOT queued — that answer never came
  // from our route, so the override state is unknown and claiming "queued"
  // would be a promise nothing keeps.
  return json?.pending === true
}

/**
 * The extra sentence a toggle answer deserves, or null when the plain
 * "Switched on." the caller composes says everything.
 *
 * Three outcomes:
 *   • queued (see isQueued)     → the route's own message, else QUEUED_COPY,
 *                                 plus the holds notice when it rides along.
 *   • plain success + holds     → the holds notice on its own.
 *   • a real failure, or a plain success with a schedule behind it → null.
 *     A failure is the CALLER's to render through errorText(), which reads the
 *     reassurance the routes deliberately fold into `error`.
 */
export function toggleResultText(json) {
  if (!json) return null
  if (isQueued(json)) {
    const code = json.pending === true ? (json.code || 'pending') : 'rate_limited'
    const queued = json.message || QUEUED_COPY[code] || QUEUED_COPY.pending
    return json.holds_until_changed ? `${queued} ${HOLDS_TEXT}` : queued
  }
  if (json.success === false) return null
  return json.holds_until_changed ? HOLDS_TEXT : null
}

/**
 * The sentence to show for a failed response body — the same chain the routes
 * were written against, re-typed from src/components/automations/shelly-fetch.js:
 *
 *   issues[0].message — validateBody's 400 shape puts the useful text here and
 *                       leaves `error` as the generic 'Invalid request'
 *   message           — a body that carried its reassurance there
 *   error             — every failure body; the routes deliberately fold their
 *                       reassurance INTO this string rather than parking it in
 *                       a `message` nobody reads
 */
export function errorText(json, fallback) {
  return json?.issues?.[0]?.message || json?.message || json?.error || fallback
}

/**
 * The name to show for a device that has none.
 *
 * Composed at render time, never stored: adopt writes `name` as the operator's
 * choice, then the Shelly account's, then NULL. A synthesised name on the row
 * would be indistinguishable from a human's the moment anyone looked at it.
 */
export function plugDisplayName(device) {
  return device?.name || `${device?.model || 'Shelly'} · ${String(device?.device_id || '').slice(-4)}`
}

// ── SHELLYGROUPS.9 — groups ─────────────────────────────────────────────────
// Re-typed from src/components/automations/ShellyGroupCard.jsx (and its
// overrideUntilLabel / outputLabel from ShellyDeviceCard.jsx). The rule the web
// card states first holds here too: a group's `now` IS THE SERVER'S ANSWER.
// GET /api/shelly/groups resolves each group's windows with the engine's own
// call, so these helpers only WORD what `now` says; they never resolve a
// window, and when the timetable could not be read (`windows_unread`) they say
// so instead of inventing a time. Zone maths comes from shared/zoned-time
// only (CLAUDE.md, Timezones): every time printed is the STUDIO's clock.

// isManaged / deviceLabel twins: a group runs on its own only when it is
// switched on AND has a schedule. On an unmanaged group the planner never
// closes an expired override, so no countdown may be printed for it.
const isManagedGroup = (g) => Boolean(g?.enabled) && g?.schedule_mode !== 'none'

/**
 * When an override ends, in the STUDIO's zone: "16:00", "16:00 tomorrow",
 * "Thu 16:00", or '' for an unreadable instant.
 *
 * Re-typed from `overrideUntilLabel` in src/components/automations/
 * ShellyDeviceCard.jsx. The route computes the default expiry as the
 * location's next local midnight, so rendering it in the phone's own zone
 * would print a time the engine will not act on. An unusable zone resolves to
 * the default zone (resolveZone) rather than costing the whole line.
 *
 * @param {string|null} iso
 * @param {number} nowMs
 * @param {string} tz  the LOCATION's IANA zone
 */
export function overrideUntilLabel(iso, nowMs, tz) {
  const ms = Date.parse(iso ?? '')
  if (!Number.isFinite(ms)) return ''
  const zone = resolveZone(tz)
  const time = timeLabelIn(new Date(ms).toISOString(), zone)
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const today = strictDayStrIn(now, zone)
  const day = strictDayStrIn(ms, zone)
  if (day === today) return time
  if (day === addDaysISO(today, 1)) return `${time} tomorrow`
  return `${formatInZone(ms, zone, { weekday: 'short' })} ${time}`
}

/**
 * The group switch's colour: 'on' | 'off' | 'mixed' | 'offline'.
 *
 * Re-typed from `groupSwitchState` (ShellyGroupCard.jsx), from the server's
 * counts: MIXED only when 0 < on_count < member_count. That amber is a display
 * state, never a third command — it is what "one member offline during a group
 * press" looks like on the next list (Review Focus 2).
 *
 * Two phone-side differences, both because the phone draws a tone where the
 * web draws a labelled pill:
 *   • 'offline' — when the caller passes the device list and EVERY member it
 *     holds reads `online: false`. A dead member's last reading may still say
 *     `output: true`; painting that green would claim lights are on that
 *     nobody can see. Absent/null `online` is not a verdict, so it never
 *     counts as offline.
 *   • an empty group (the web's 'empty') is 'off': nothing in it is on.
 *
 * @param {object} group      a GET /api/shelly/groups row (with `now`, `device_ids`)
 * @param {object[]} [devices] the GET /api/shelly/devices rows, to read `online`
 */
export function groupTone(group, devices) {
  const ids = new Set(Array.isArray(group?.device_ids) ? group.device_ids : [])
  const members = (Array.isArray(devices) ? devices : []).filter((d) => d && ids.has(d.id))
  if (members.length > 0 && members.every((d) => d.last_state?.online === false)) return 'offline'
  const count = Number(group?.now?.member_count) || 0
  const on = Number(group?.now?.on_count) || 0
  if (count <= 0 || on <= 0) return 'off'
  if (on >= count) return 'on'
  return 'mixed'
}

// Today's fixed hours by the STUDIO's weekday (ISO, 1 = Monday): "06:00–21:00",
// several joined with commas, or null when no window runs today.
function fixedHoursToday(windows, zone, nowMs) {
  const { weekday } = instantToZonedParts(nowMs, zone)
  const today = (Array.isArray(windows) ? windows : [])
    .filter((w) => Array.isArray(w?.days) && w.days.includes(weekday) && w.on && w.off)
    .sort((a, b) => String(a.on).localeCompare(String(b.on)))
  if (!today.length) return null
  return today.map((w) => `${w.on}–${w.off}`).join(', ')
}

/**
 * The one line under a group's name, worded from the server's `now`:
 *   "Follows classes · on until 19:10", "Fixed hours · 06:00–21:00",
 *   "1 of 2 on · manual until midnight", "Never automatic".
 *
 * Re-typed from `groupReasonLine` in ShellyGroupCard.jsx, branch for branch.
 *
 * @param {object} group  a GET /api/shelly/groups row (with `now`)
 * @param {string} tz     the LOCATION's IANA zone
 * @param {number} [nowMs] testable clock
 * @param {{ withCount?: boolean }} [opts]  `withCount: false` drops the mixed
 *   "1 of 2 on · " prefix — the phone card prints that count on its own amber
 *   line (groupSwitchView's countText), so it must not appear twice.
 */
export function groupReasonLine(group, tz, nowMs, { withCount = true } = {}) {
  const zone = resolveZone(tz)
  const at = Number.isFinite(nowMs) ? nowMs : Date.now()
  const now = group?.now || {}
  let reason
  if (now.mode === 'override') {
    if (!isManagedGroup(group)) reason = 'Manual · stays until changed'
    else if (timeLabelIn(now.until, zone) === '00:00') reason = 'Manual until midnight'
    else reason = `Manual until ${overrideUntilLabel(now.until, at, zone)}`
  } else if (now.mode === 'none' || !isManagedGroup(group)) {
    reason = 'Never automatic'
  } else if (group.schedule_mode === 'fixed') {
    const hours = fixedHoursToday(group.fixed_windows, zone, at)
    // An overnight window opened yesterday is not in today's list, but the
    // server says it is open: name its end rather than claim "off today".
    if (hours) reason = `Fixed hours · ${hours}`
    else if (now.mode === 'window' && now.until) reason = `Fixed hours · on until ${timeLabelIn(now.until, zone)}`
    else reason = 'Fixed hours · off today'
  } else if (now.windows_unread) {
    reason = "Follows classes · couldn't read today's classes"
  } else if (now.mode === 'window' && now.until) {
    reason = `Follows classes · on until ${timeLabelIn(now.until, zone)}`
  } else if (now.next_on) {
    reason = `Follows classes · next on at ${timeLabelIn(now.next_on, zone)}`
  } else {
    reason = 'Follows classes · no more classes today'
  }
  if (!withCount || groupTone(group) !== 'mixed') return reason
  return `${now.on_count} of ${now.member_count} on · ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
}

/**
 * The relay as words, with a light's brightness: "On · 55%", "On", "Off",
 * "Unknown". Re-typed from `outputLabel` in ShellyDeviceCard.jsx: a switch
 * never shows a brightness, even if a stray key rode in on its state, and
 * `output: null` is Unknown, never Off (plugStateLabel's rule).
 */
export function lightStateLabel(device) {
  const state = device?.last_state || {}
  if (state.output === true) {
    return device?.kind === 'light' && Number.isFinite(state.brightness)
      ? `On · ${Math.round(state.brightness)}%`
      : 'On'
  }
  if (state.output === false) return 'Off'
  return 'Unknown'
}

/**
 * A member row's power column: "42 W", "Doesn’t report power" or "—".
 * Re-typed from ShellyGroupCard's MemberRow (SHELLYNOPOWER.1's rule): only an
 * ONLINE reading with `apower` AND `aenergy_wh` both absent means the hardware
 * meters nothing. Offline, or one figure present, is simply not known.
 */
export function memberPowerText(device) {
  const state = device?.last_state || {}
  if (Number.isFinite(state.apower)) return `${Math.round(state.apower)} W`
  if (state.online === true && state.apower == null && state.aenergy_wh == null) return 'Doesn’t report power'
  return '—'
}

// ── SHELLYGROUPS.10 — the phone screen's arrangement ───────────────────────
// mobile/ has no React Native screen harness, so every decision the redesigned
// screen makes is here and pinned by shelly-screen.test.js; the screen file
// does IO and layout only.

/**
 * Which card each device is drawn in.
 *
 * Groups keep the SERVER's order (GET /api/shelly/groups sorts by sort_order
 * then name) and each group's members follow its `device_ids`. A device whose
 * id the group list missed but whose `group_id` names a listed group joins it
 * (the member read is capped server-side). Everything else — no group, or a
 * group the list does not hold — goes in the last card: a device is NEVER
 * hidden because the group read and the device read disagree. A device two
 * groups claim is drawn once, under the first.
 *
 * With no groups (none made, or the list unreadable) there is nothing for
 * devices to be "not in", so the last card is just "Devices".
 *
 * @param {object[]|null} devices  GET /api/shelly/devices rows
 * @param {object[]|null} groups   GET /api/shelly/groups rows (null = unread)
 */
export function arrangeShellyCards(devices, groups) {
  const list = (Array.isArray(devices) ? devices : []).filter(Boolean)
  const groupList = (Array.isArray(groups) ? groups : []).filter(Boolean)
  const byId = new Map(list.map((d) => [d.id, d]))
  const placed = new Set()
  const cards = groupList.map((group) => {
    const members = []
    for (const id of Array.isArray(group.device_ids) ? group.device_ids : []) {
      const d = byId.get(id)
      if (d && !placed.has(id)) { members.push(d); placed.add(id) }
    }
    return { group, members }
  })
  const cardById = new Map(cards.map((c) => [c.group.id, c]))
  for (const d of list) {
    if (placed.has(d.id) || !d.group_id || !cardById.has(d.group_id)) continue
    cardById.get(d.group_id).members.push(d)
    placed.add(d.id)
  }
  return {
    groups: cards,
    ungrouped: list.filter((d) => !placed.has(d.id)),
    ungroupedTitle: cards.length ? 'Not in a group' : 'Devices',
  }
}

/**
 * The ONE switch on a group card.
 *
 * Tone from groupTone (server counts; amber mixed only when 0 < on < count),
 * unless a partial press is being painted: `partial` is the `{ on, count }`
 * groupToggleOutcome returned, shown until the next poll replaces it with
 * the server's counts. A press sends 'off' when every member reads on —
 * whatever the tone, an all-offline group included — and 'on' otherwise
 * (mixed and off both send 'on': the obvious meaning of tapping an amber
 * switch is "all of them on").
 *
 * The accessibility label is the group's NAME only: on/off/mixed reach a
 * screen reader through accessibilityState.checked, and the facts the
 * checked state cannot carry (the count, offline, no devices) through
 * `accessibilityValue`.
 *
 * An empty group says "No devices" and cannot be pressed. Otherwise only
 * `connected === false` disables it — an offline group is still settable,
 * the press is saved and applied when the members are back (rule 3).
 *
 * @param {object} group
 * @param {object[]} [devices]
 * @param {{ connected?: boolean|null, partial?: {on:number, count:number}|null }} [opts]
 */
export function groupSwitchView(group, devices, { connected, partial } = {}) {
  const name = group?.name || 'Group'
  const count = Number(group?.now?.member_count) || 0
  const idsCount = Array.isArray(group?.device_ids) ? group.device_ids.length : 0
  if (count <= 0 && idsCount <= 0) {
    return {
      tone: 'off', checked: false, nextState: 'on', empty: true, disabled: true,
      countText: 'No devices', accessibilityLabel: name, accessibilityValue: 'no devices',
    }
  }
  const disabled = connected === false
  if (partial && Number.isFinite(partial.on) && Number.isFinite(partial.count) && partial.count > 0) {
    const all = partial.on >= partial.count
    const none = partial.on <= 0
    const tone = all ? 'on' : none ? 'off' : 'mixed'
    const countText = tone === 'mixed' ? `${partial.on} of ${partial.count} on` : null
    return {
      tone, checked: tone === 'mixed' ? 'mixed' : all, nextState: all ? 'off' : 'on',
      empty: false, disabled, countText,
      accessibilityLabel: name, accessibilityValue: countText,
    }
  }
  const tone = groupTone(group, devices)
  const on = Number(group?.now?.on_count) || 0
  const allOn = count > 0 && on >= count
  const countText = tone === 'mixed' ? `${on} of ${count} on` : null
  const checked = tone === 'mixed' ? 'mixed' : allOn
  return {
    tone, checked, nextState: allOn ? 'off' : 'on', empty: false, disabled, countText,
    accessibilityLabel: name,
    accessibilityValue: tone === 'offline' ? 'offline' : countText,
  }
}

// The group twin of HOLDS_TEXT, for a toggle answer that says
// `holds_until_changed` without the route's own `notice`.
export const GROUP_HOLDS_TEXT = 'No schedule runs this group — it stays as set until you change it.'

/**
 * What a group press says, and what (if anything) to paint before the next
 * poll. BRANCHES ON `pending` FIRST: every queued and partial body says
 * `success: true`, and the 429 rate-limit body arrives through api()
 * unchanged with `pending: true`, so a success-first read would print
 * "Switched on." over a group whose relays have not moved. The route's
 * `message` is shown first whenever it sent one.
 *
 * `partial` ({ on, count }) is only returned for `applied: 'partial'`: the
 * members in `pending_device_ids` did not move, so after an ON press the rest
 * are on, and after an OFF press the pending ones are the ones still on (the
 * best the answer can say; the next poll's counts replace it).
 *
 * @param {object|null} json   the api() result of POST /api/shelly/groups/<id>/toggle
 * @param {'on'|'off'} state   what was asked for
 * @param {number} memberCount the group's member count when it was pressed
 * @returns {{ tone: 'ok'|'warn'|'error', text: string, partial: {on:number, count:number}|null }}
 */
export function groupToggleOutcome(json, state, memberCount) {
  if (!json) return { tone: 'error', text: 'That did not work — try again', partial: null }
  // The route's GROUP_HOLDS_NOTICE carries no full stop (the web shows it on
  // its own); composed after "Switched on." it is a sentence and needs one.
  const rawHolds = json.holds_until_changed ? String(json.notice || GROUP_HOLDS_TEXT).trim() : ''
  const holds = rawHolds ? (/[.!?]$/.test(rawHolds) ? rawHolds : `${rawHolds}.`) : null
  const withHolds = (text) => (holds ? `${text} ${holds}` : text)
  if (json.pending === true || json.applied === 'partial') {
    const text = withHolds(json.message || 'Saved — the group will follow as soon as Shelly answers.')
    let partial = null
    if (json.applied === 'partial') {
      const count = Number(memberCount) || 0
      const pending = Array.isArray(json.pending_device_ids) ? json.pending_device_ids.length : 0
      if (count > 0) partial = { on: state === 'on' ? Math.max(0, count - pending) : Math.min(count, pending), count }
    }
    return { tone: 'warn', text, partial }
  }
  if (json.success !== true) {
    return { tone: 'error', text: errorText(json, 'That did not work'), partial: null }
  }
  return { tone: 'ok', text: withHolds(state === 'on' ? 'Switched on.' : 'Switched off.'), partial: null }
}

// ── Back to schedule ───────────────────────────────────────────────────────
// Re-typed from ShellyGroupCard.jsx (AUTO_REASON_COPY, AUTO_CODE_COPY,
// joinNames, autoOutcomeText). POST …/toggle with `state: 'auto'` answers
// `applied: 'all'|'partial'|'none'|null` with `results[]` per member, or
// `applied: null` + `reason` when the group has nothing to go back to.

const AUTO_REASON_COPY = Object.freeze({
  disabled: 'This group has no schedule — pick fixed hours or follow classes on the web CRM first.',
  no_schedule: 'This group has no schedule — pick fixed hours or follow classes on the web CRM first.',
})

const AUTO_CODE_COPY = Object.freeze({
  auth: 'Shelly rejected the stored key — re-paste it on the web CRM.',
  rate_limited: 'Shelly is busy right now — the group will follow within a minute.',
  config: 'The Shelly server on file is invalid — fix it on the web CRM.',
})

const joinNames = (names) => (names.length <= 1
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/**
 * Should a group card offer "Back to schedule"? Only a MANAGED group (switched
 * on, with a schedule) that is currently on a manual override: an unmanaged
 * group has nothing to go back to (the route answers `reason` for it).
 */
export function showBackToSchedule(group) {
  return Boolean(group?.enabled) && group?.schedule_mode !== 'none' && group?.now?.mode === 'override'
}

/**
 * What "Back to schedule" did, from the route's `results[]`, or null when
 * every member moved. Re-typed from `autoOutcomeText` (ShellyGroupCard.jsx),
 * with the fixes pointed at the web CRM (mobile has no connection settings).
 *
 * @param {Array<{device_id: string, applied: string|null, code?: string, permanent?: boolean}>} results
 * @param {(id: string) => string} nameOf
 */
export function autoOutcomeText(results, nameOf) {
  const list = Array.isArray(results) ? results : []
  const missed = list.filter((r) => r && r.applied == null)
  if (!missed.length) return null
  if (missed.some((r) => r.code === 'occurrences')) {
    return "Couldn't read today's classes — nothing was switched. Try again in a minute."
  }
  const name = typeof nameOf === 'function' ? nameOf : () => 'a device'
  const total = list.length
  const moved = total - missed.length
  const parts = []
  const names = (rows) => joinNames(rows.map((r) => name(r.device_id)))

  const refused = missed.filter((r) => r.permanent === true)
  if (refused.length) {
    parts.push(`Shelly refused ${names(refused)} — check ${refused.length === 1 ? 'it' : 'them'} in the Shelly app.`)
  }
  const accountWide = new Set()
  for (const r of missed) if (!r.permanent && AUTO_CODE_COPY[r.code]) accountWide.add(AUTO_CODE_COPY[r.code])
  parts.push(...accountWide)

  const mismatch = missed.filter((r) => r.code === 'plan_mismatch')
  if (mismatch.length) parts.push(`${names(mismatch)} ${mismatch.length === 1 ? 'was' : 'were'} not switched.`)
  const unverified = missed.filter((r) => r.code === 'unverified' || r.code === 'bad_device')
  if (unverified.length) parts.push(`Couldn't confirm ${names(unverified)}.`)

  const handled = new Set(['plan_mismatch', 'unverified', 'bad_device', ...Object.keys(AUTO_CODE_COPY)])
  const silent = missed.filter((r) => !r.permanent && !handled.has(r.code))
  if (silent.length) {
    const one = silent.length === 1
    parts.push(`${names(silent)} did not answer — ${one ? 'it' : 'they'} will follow when ${one ? 'it is' : 'they are'} back online.`)
  }
  const lead = moved > 0 ? `Back on schedule for ${moved} of ${total}.` : 'Nothing moved yet.'
  return `${lead} ${parts.join(' ')}`
}

/**
 * What a "Back to schedule" press says. Same order as the switch: a failure
 * first, then anything that did not fully land (`pending`, `partial`, `none`
 * — the route's `message`, else autoOutcomeText over `results[]`), and only
 * then success: `applied: null` with a `reason` is "nothing to go back to",
 * anything else is "Back on schedule."
 *
 * @param {object|null} json
 * @param {(id: string) => string} nameOf  device id → its display name
 * @returns {{ tone: 'ok'|'warn'|'error', text: string }}
 */
export function groupAutoOutcome(json, nameOf) {
  if (!json) return { tone: 'error', text: 'That did not work — try again' }
  if (json.success === false) return { tone: 'error', text: errorText(json, 'That did not work') }
  if (json.pending === true || json.applied === 'partial' || json.applied === 'none') {
    return {
      tone: 'warn',
      text: json.message || autoOutcomeText(json.results, nameOf)
        || 'Saved. Some devices have not moved yet — they will follow as soon as they are back online.',
    }
  }
  if (json.success !== true) return { tone: 'error', text: errorText(json, 'That did not work') }
  if (AUTO_REASON_COPY[json.reason]) return { tone: 'warn', text: AUTO_REASON_COPY[json.reason] }
  return { tone: 'ok', text: 'Back on schedule.' }
}

/**
 * A device's own small switch (a member row, or a "Not in a group" row).
 * `output: null` is UNKNOWN — neither side of the switch (rule 1). Pressing an
 * unknown switch sends the opposite of what the engine last APPLIED
 * (`last_applied.action === 'on'` → 'off'), since that is the likeliest real
 * state; with no record it sends 'on'. Only `connected === false` disables it
 * (rule 3).
 *
 * The label is the device's NAME only (on/off reaches a screen reader through
 * accessibilityState.checked); "state unknown" and a light's brightness go in
 * `accessibilityValue`.
 */
export function deviceSwitchView(device, connected) {
  const output = device?.last_state?.output
  const tone = output === true ? 'on' : output === false ? 'off' : 'unknown'
  let nextState = output === true ? 'off' : 'on'
  if (tone === 'unknown' && device?.last_applied?.action === 'on') nextState = 'off'
  const brightness = device?.kind === 'light' && output === true && Number.isFinite(device?.last_state?.brightness)
    ? `${Math.round(device.last_state.brightness)}%`
    : null
  return {
    tone,
    checked: tone === 'unknown' ? undefined : output === true,
    nextState,
    disabled: connected === false,
    accessibilityLabel: plugDisplayName(device),
    accessibilityValue: tone === 'unknown' ? 'state unknown' : brightness,
  }
}

/**
 * A member row's right-hand facts: the Offline chip (a reading that says
 * `online: false` — then no power figure, the last one is not live), the relay
 * words (a light's "On · 55%") and the watts / "Doesn’t report power". An
 * unknown figure ('—') shows nothing.
 */
export function memberMeta(device) {
  const offline = device?.last_state?.online === false
  const power = offline ? null : memberPowerText(device)
  return { offline, power: power === '—' ? null : power, state: lightStateLabel(device) }
}

/**
 * The header's "412 W now": the sum of every reading that is live. An
 * offline plug's last figure is not "now", and absent is not zero, so a
 * screen with no reading at all gets null (the part is omitted), while a real
 * 0 W total is shown.
 */
export function totalWattsText(devices) {
  let total = 0
  let any = false
  for (const d of Array.isArray(devices) ? devices : []) {
    const s = d?.last_state || {}
    if (s.online === false || !Number.isFinite(s.apower)) continue
    total += s.apower
    any = true
  }
  return any ? `${Math.round(total)} W now` : null
}

/**
 * The amber banner over the list, from countUnadoptedShelly (mobile/lib/api.js).
 * null (the discover list could not be read) and 0 both hide it: an unread
 * list is unknown, never "nothing to adopt", and unknown is not worth a banner.
 */
export function unadoptedBannerText(n) {
  if (!Number.isFinite(n) || n <= 0) return null
  return n === 1
    ? '1 device on your Shelly account isn’t set up here — set it up on the web CRM.'
    : `${n} devices on your Shelly account aren’t set up here — set them up on the web CRM.`
}

/**
 * The read window for the header's next class: now until the STUDIO's next
 * local midnight (shared/zoned-time — the class_occurrences day is the
 * studio's, never the phone's).
 */
export function nextClassWindow(nowMs, tz) {
  const zone = resolveZone(tz)
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  return {
    fromIso: new Date(now).toISOString(),
    toIso: new Date(nextLocalMidnightMs(now, zone)).toISOString(),
  }
}

/**
 * "next class 18:00 BU1LD" — the soonest uncancelled class still to start,
 * on the studio's clock — or null when there is none left today or the list
 * could not be read (the header then simply omits the part). Picked at
 * render time from the list read on focus, so a screen left open past a
 * class's start moves on to the next one at the next poll's repaint.
 */
export function nextClassLabel(occurrences, nowMs, tz) {
  const zone = resolveZone(tz)
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  let best = null
  let bestMs = Infinity
  for (const o of Array.isArray(occurrences) ? occurrences : []) {
    if (!o || o.cancelled_at) continue
    const ms = Date.parse(o.starts_at ?? '')
    if (!Number.isFinite(ms) || ms <= now || ms >= bestMs) continue
    best = o
    bestMs = ms
  }
  if (!best) return null
  const time = timeLabelIn(new Date(bestMs).toISOString(), zone)
  const name = best.name || best.program
  return name ? `next class ${time} ${name}` : `next class ${time}`
}

/** "UN1T Stillorgan · next class 18:00 BU1LD · 412 W now", unknown parts dropped. */
export function screenHeaderLine({ studio, nextClass, watts } = {}) {
  return [studio, nextClass, watts].filter((x) => typeof x === 'string' && x.length > 0).join(' · ')
}

// A group's `icon` (mig 776's CHECK list) → the nearest Ionicons glyph, the
// set the rest of the app draws with. Ionicons has no fan; the aperture's
// blades are the nearest shape.
export const GROUP_ICON_NAMES = Object.freeze({
  bulb: 'bulb-outline',
  fan: 'aperture-outline',
  tv: 'tv-outline',
  plug: 'flash-outline',
  droplet: 'water-outline',
})

export function groupIconName(icon) {
  return GROUP_ICON_NAMES[icon] || GROUP_ICON_NAMES.plug
}
