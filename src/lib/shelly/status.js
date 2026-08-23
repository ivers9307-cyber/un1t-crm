// SHELLY.4 — pure normalisers for Shelly Cloud payloads. Defensive on
// purpose: the v2 `get` item field names and the v1 `all_status` `_dev_info`
// shape were read from docs, not a live account (see the spec's
// "unverified shapes"). Nothing here throws on a surprising body.
//
// Two rules run through the whole file:
//
//  1. ABSENT IS NOT ZERO. A non-metering relay (Plus 1, a Pro 4PM's unmetered
//     channels) has no power reading at all, and Shelly also sends an
//     explicit `null` when a measurement is momentarily unavailable. Both
//     must land as null, never 0 — a 0 W reading is a claim about the world
//     ("this thing is drawing nothing"), and we are not entitled to make it.
//
//  2. NO EVIDENCE IS NOT A VERDICT. `supported:false` is a dead end for the
//     operator: an unsupported device cannot be adopted. So we only say it
//     when the device NAMED its components and no relay was among them —
//     never merely because the body had some keys in it. A status that is
//     empty, absent, or nothing but envelope (normal for an offline device,
//     and possible for an online one given the shapes above are unverified)
//     is `supported:null` = "ask again later", not "this is a 3EM".

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// Numbers only, and only real ones. Number() is far too eager to be used
// raw here: Number(null), Number(''), Number([]) and Number(false) are all
// 0, which is exactly the reading we must never invent (rule 1). Numeric
// strings are accepted because a stringly-typed body is cheap to tolerate.
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

// Non-blank strings only. A '' name or source is junk, not a value, and it
// would otherwise survive `??` (which only falls through on null/undefined)
// and read as a real device name in the adopt list.
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)

// 2 | 'G2' | 'gen2'. Typed narrowly rather than String()-ing whatever
// arrived, so a hostile shape can never reach a toString.
function parseGen(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null
  if (typeof raw !== 'string') return null
  const m = raw.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

function channelFromSwitch(n, sw) {
  const s = isObj(sw) ? sw : {}
  return {
    channel: n,
    output: typeof s.output === 'boolean' ? s.output : null,
    apower: num(s.apower),
    aenergy_wh: num(s.aenergy?.total),
    temperature_c: num(s.temperature?.tC),
    source: str(s.source),
  }
}

// Canonical `switch:N` only. `\d+` would also take `switch:00`, which parses
// to a second channel 0 — a duplicate row, and two rows racing for one
// group_id.
const SWITCH_KEY_RE = /^switch:(0|[1-9]\d*)$/

// A Gen2+ COMPONENT INSTANCE: a lowercase type followed by an index —
// `switch:0`, `em:0`, `em1:0`, `temperature:0`, `humidity:0`. The singleton
// components (`sys`, `wifi`, `cloud`, `mqtt`, `ble`, `ws`, `eth`) carry no
// index and deliberately do NOT match: they are the envelope every device
// sends, so they say nothing about what this one can do.
const COMPONENT_INSTANCE_RE = /^[a-z][a-z0-9_]*:\d+$/

function switchChannels(status) {
  const out = []
  for (const key of Object.keys(isObj(status) ? status : {})) {
    const m = key.match(SWITCH_KEY_RE)
    if (m) out.push(channelFromSwitch(Number(m[1]), status[key]))
  }
  return out.sort((a, b) => a.channel - b.channel)
}

// `no_switch` is judged on POSITIVE evidence — some component instance is
// present and none of them is a switch — never on "the body had keys in it".
// Key-counting looks equivalent and is not: an ordinary offline Plug S comes
// back as `{_dev_info, cloud:{connected:false}}` (v1) or `{cloud:{}, sys:{}}`
// (v2), which is one key past empty and would have been sentenced to
// `supported:false` — permanently unadoptable, for the single most common
// device in the estate. `statusKeys` still arrives pre-filtered of the v1
// `_dev_info` envelope; that is now belt-and-braces rather than the guard.
function supportFor({ gen, status, channels, statusKeys }) {
  if ((gen != null && gen < 2) || Array.isArray(status?.relays) || Array.isArray(status?.meters)) {
    return { supported: false, reason: 'gen1' }
  }
  if (channels.length) return { supported: true }
  // Components, but no relay among them: a Pro 3EM (`em:0`), an H&T
  // (`temperature:0`). The device told us what it is, so this is a verdict.
  if (statusKeys.some((k) => COMPONENT_INSTANCE_RE.test(k))) return { supported: false, reason: 'no_switch' }
  return { supported: null } // nothing to judge; see rule 2
}

function nameFrom(settings, fallback) {
  return str(settings?.sys?.device?.name) ?? str(settings?.name) ?? str(fallback) ?? null
}

// The column/schema bound: ShellyAdoptBody.name and ShellyDevicePatch.name are
// both .max(80), so a longer label resolved here would be storable by this
// path and un-editable by the operator afterwards — the PATCH that merely
// re-saved it would 400 on a name nobody typed.
const NAME_MAX = 80

// SHELLY-NAMES.1 — the LIST inside a v2 `get` body, before normalisation.
//
// Extracted so the two callers that need the RAW item (adopt, sync-names)
// detect the list exactly the way normaliseGetItems does. A second copy of
// this three-way check is how one surface would start reading `{devices:[…]}`
// and the other only a bare array, silently, on the same account.
export function rawItemsOf(body) {
  return Array.isArray(body) ? body
    : Array.isArray(body?.devices) ? body.devices
    : Array.isArray(body?.data) ? body.data : []
}

// The id normalisation that decides which raw item is which device. Same rule
// as normaliseGetItem's (string or number only, trimmed, lowercased), and
// exported for the same reason as rawItemsOf: a caller matching raw items to
// database rows must key them identically, or a perfectly good item silently
// belongs to nobody.
export function rawItemId(item) {
  const raw = typeof item?.id === 'string' || typeof item?.id === 'number' ? String(item.id).trim() : ''
  return raw ? raw.toLowerCase() : null
}

// Every `switch:N` key the item mentions, in EITHER half of the payload.
// `status` alone is not enough: an offline device reports no switch components
// at all (rule 2) while its `settings` still names all four of a 4PM's
// outputs — and it is exactly the multi-output case that decides whether the
// per-output label wins below.
function switchKeys(item) {
  const out = new Set()
  for (const bag of [item?.status, item?.settings]) {
    for (const key of Object.keys(isObj(bag) ? bag : {})) {
      if (SWITCH_KEY_RE.test(key)) out.add(key)
    }
  }
  return [...out]
}

/**
 * SHELLY-NAMES.1 — where a Shelly device's human label actually lives.
 *
 * Takes the RAW v2 `get` item (not a normalised row) and the channel being
 * named; returns a trimmed, capped string or null. Pure.
 *
 * WHY IT IS WIDER THAN nameFrom. nameFrom reads two places
 * (settings.sys.device.name, settings.name) and that matched the documented
 * shape. It did NOT match the live account: six Shelly 1 Mini Gen3 relays at
 * Stillorgan adopted with every card showing the `<model> · <last4>`
 * placeholder, the devices plainly named in the Shelly app, and NOT ONE
 * warning out of the adopt route — so `settings` came back and the label was
 * somewhere neither of those two reads looks. nameShapeDiagnostic() below is
 * how we find out where; this is the net that catches it in the meantime.
 *
 * The order is by how much each source is a claim about THIS CHANNEL rather
 * than about the box:
 *
 *   (a) settings['switch:N'].name on a MULTI-RELAY device. A Pro 4PM is one
 *       box and four outputs and the operator names the outputs ("Sauna",
 *       "Ice bath"), so the per-output label beats the box's. Single-relay
 *       devices drop it to (f) instead, because there the same field is
 *       usually absent or a factory label.
 *   (b) settings.sys.device.name — the documented Gen2+ home.
 *   (c) settings.device.name     — the same field one level shallower.
 *   (d) settings.name            — the flat form.
 *   (e) item.name                — the cloud envelope's own.
 *   (f) settings['switch:N'].name on a single-relay device: better than the
 *       placeholder once every box-level source came back empty.
 *   (g) status.sys.device.name   — defensive. Nothing observed puts it here,
 *       and if this arm ever wins, the diagnostic is what says so.
 *
 * NEVER returns '' — str() drops blanks, so a factory-blank name falls through
 * to the next source instead of being stored as a name a human chose.
 */
export function resolveDeviceName(item, channel = 0) {
  const settings = isObj(item?.settings) ? item.settings : null
  const status = isObj(item?.status) ? item.status : null
  const ch = Number.isInteger(channel) && channel >= 0 ? channel : 0
  const perChannel = str(settings?.[`switch:${ch}`]?.name)
  const multiRelay = switchKeys(item).length >= 2

  const picked =
    (multiRelay ? perChannel : null)
    // The CLOUD's own label. Not part of Shelly.GetConfig — the cloud grafts a
    // `DeviceInfo` envelope onto `settings` — and it is where the Smart
    // Control app's name actually lives: the Stillorgan live gate
    // (SHELLY-NAMES.2) showed six app-named Gen3 Minis whose
    // `sys.device.name` was null while `settings.DeviceInfo` was present.
    // The app labels the ACCOUNT record, not the device, so this outranks
    // the on-device name.
    ?? str(settings?.DeviceInfo?.name)
    ?? str(settings?.sys?.device?.name)
    ?? str(settings?.device?.name)
    ?? str(settings?.name)
    ?? str(item?.name)
    ?? perChannel
    ?? str(status?.sys?.device?.name)
  if (picked == null) return null
  const trimmed = picked.trim().slice(0, NAME_MAX)
  // A trimmed non-blank string cannot slice to blank at 80, but the cap is the
  // one place a future NAME_MAX of 0 would silently mint the empty name the
  // whole file exists to avoid.
  return trimmed || null
}

// ——— keys-only diagnostic ————————————————————————————————————————————
//
// SECRET RULE, and it is the whole reason this is a function rather than a log
// of the payload: `settings` carries the device's wifi credentials
// (settings.wifi.sta.pass) and its MQTT broker password. NOTHING in here may
// be a VALUE from the payload — every field is either an array of KEY NAMES or
// a typeof-style string. status.test.js pins that with a fixture carrying a
// planted secret and a planted name, and asserts neither survives
// JSON.stringify of the result.
const DIAG_KEY_CAP = 40

// Sorted so two devices' shapes are comparable at a glance, and capped so a
// pathological body cannot turn one warning into a log page.
const keysOf = (v) => (isObj(v) ? Object.keys(v).sort().slice(0, DIAG_KEY_CAP) : [])

// typeof, with the two cases typeof gets wrong for this purpose split out.
const typeName = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)

/**
 * SHELLY-NAMES.1 — the SHAPE of a `get` item, for the one question we cannot
 * answer from Dublin: where does this account put the device label?
 *
 * Nothing on this surface stores or logs raw Shelly payloads, by design, so a
 * device that resolves no name is otherwise a dead end — the adopt route saw
 * `settings`, found nothing, and said nothing. This is the minimum that turns
 * one operator press into an answer: which keys exist, and whether
 * settings.sys.device.name is a string, a non-string, or absent.
 *
 * `deviceKeys` descends settings.sys.device, falling back to settings.device
 * when sys carries no device — `sysKeys` says which of the two you are
 * looking at.
 */
export function nameShapeDiagnostic(item) {
  const settings = isObj(item?.settings) ? item.settings : null
  const status = isObj(item?.status) ? item.status : null
  const sys = isObj(settings?.sys) ? settings.sys : null
  const device = isObj(sys?.device) ? sys.device : (isObj(settings?.device) ? settings.device : null)
  const firstSwitchKey = Object.keys(settings || {}).find((k) => SWITCH_KEY_RE.test(k))
  const nameProp = device && Object.prototype.hasOwnProperty.call(device, 'name')
    ? (typeof device.name === 'string' ? 'string' : 'null')
    : 'absent'
  return {
    itemKeys: keysOf(item),
    settingsType: typeName(item?.settings),
    settingsKeys: keysOf(settings),
    sysKeys: keysOf(sys),
    deviceKeys: keysOf(device),
    // The cloud grafts a `DeviceInfo` envelope onto `settings` (not part of
    // Shelly.GetConfig) — SHELLY-NAMES.2 found the app's label there. Keys
    // only, like everything else here.
    deviceInfoKeys: keysOf(isObj(settings?.DeviceInfo) ? settings.DeviceInfo : null),
    switchKeys: firstSwitchKey ? keysOf(settings[firstSwitchKey]) : [],
    hasSysDeviceName: nameProp,
    statusKeys: keysOf(status),
  }
}

export function normaliseGetItem(item) {
  if (!isObj(item)) return null
  // MACs arrive as strings; a number id is tolerated, anything else (object,
  // array, blank) is not an id and the row is dropped rather than becoming
  // '[object object]' or ''.
  const deviceId = rawItemId(item)
  if (!deviceId) return null
  const status = isObj(item.status) ? item.status : {}
  const online = item.online === 1 || item.online === true
  const gen = parseGen(item.gen)
  const channels = switchChannels(status)
  return {
    device_id: deviceId,
    online, gen,
    model: str(item.code) ?? str(item.type) ?? null,
    // The cron's `select` is ['status'] only, so `settings` — and with it the
    // device name — is absent on almost every read. Discovery asks for
    // ['status','settings']; everywhere else null here is the normal case,
    // not a failure.
    // SHELLY-NAMES.1 — resolveDeviceName, not nameFrom: discovery and adopt
    // both read through here, and the two-place lookup demonstrably missed the
    // label on a live Gen3 account. Channel 0 is the single-channel default;
    // the routes that know which channel is being named call
    // resolveDeviceName themselves with the real one.
    name: resolveDeviceName(item, 0),
    channels,
    ...supportFor({ gen, status, channels, statusKeys: Object.keys(status) }),
  }
}

export function normaliseGetItems(body) {
  return rawItemsOf(body).map(normaliseGetItem).filter(Boolean)
}

// v1 /device/all_status → one row per relay channel, for the adopt flow.
export function normaliseAllStatus(body) {
  const devices = isObj(body?.data?.devices_status) ? body.data.devices_status : {}
  const rows = []
  for (const [rawId, entry] of Object.entries(devices)) {
    // Same guard as the v2 path: a blank key is not a device id, and a row
    // carrying one could only ever be an unadoptable entry in the adopt list.
    const deviceId = String(rawId).trim().toLowerCase()
    if (!deviceId) continue
    const e = isObj(entry) ? entry : {}
    const info = isObj(e._dev_info) ? e._dev_info : {}
    const gen = parseGen(info.gen)
    const online = info.online === true || info.online === 1 || e.cloud?.connected === true
    const channels = switchChannels(e)
    // `_dev_info` is Shelly Cloud's envelope, not something the device
    // reported — an entry carrying only that told us nothing (rule 2).
    const statusKeys = Object.keys(e).filter((k) => k !== '_dev_info')
    const support = supportFor({ gen, status: e, channels, statusKeys })
    const base = {
      device_id: deviceId,
      model: str(info.code) ?? str(info.type) ?? null,
      gen,
      online,
      // SHELLY-UI.4b — `_dev_info.name` is the fallback, not null. The v1
      // entry itself rarely carries the human name; the cloud envelope often
      // does, and discovery is the ONE surface where the name is the whole
      // point — a null here renders the adopt list as a wall of MACs and the
      // operator cannot tell the sauna from the ice machine. Still a fallback,
      // never an override: a name the DEVICE reported wins over the account's.
      name: nameFrom(e, info.name),
      ...support,
    }
    // Still emit one row for a device with no channels: the adopt list has to
    // be able to show it and say why it cannot be adopted.
    if (!channels.length) { rows.push({ ...base, channel: 0, output: null }); continue }
    for (const c of channels) rows.push({ ...base, channel: c.channel, output: c.output })
  }
  return rows
}

// next last_state for one adopted row. Offline: keep what we last knew
// about output/power, flip online, do NOT advance last_seen_at (caller).
// A missing reading counts as offline — same conservative treatment, since
// "we did not hear from it" is all either case actually tells us.
//
// CONSUMER TRAP: across an offline span the measurements are FROZEN at their
// last-known values while `at` keeps advancing. So an (aenergy_wh, at) pair
// diffed across that span reads as "0 Wh consumed over N minutes", which is a
// measurement we never made. Anything differencing energy over time must gate
// on `online` first (the daily roll does, and is safe).
export function stateFromReading(prev, reading, channel, atIso) {
  const p = isObj(prev) ? prev : {}
  if (!reading?.online) {
    return { online: false, output: p.output ?? null, apower: p.apower ?? null, aenergy_wh: p.aenergy_wh ?? null,
      temperature_c: p.temperature_c ?? null, source: p.source ?? null, at: atIso }
  }
  // Online but this channel is gone (adopted channel 3, device now reports
  // 0-1): nulls, not stale values — the device is talking and not mentioning
  // it, which is different from having heard nothing.
  const list = Array.isArray(reading.channels) ? reading.channels : []
  const c = list.find((x) => x?.channel === channel) || channelFromSwitch(channel, null)
  return { online: true, output: c.output, apower: c.apower, aenergy_wh: c.aenergy_wh, temperature_c: c.temperature_c, source: c.source, at: atIso }
}

// Cheap fields are compared exactly; the measured ones get a deadband so a
// wattmeter twitching in the third decimal does not cost a row write per
// device per minute. The refresh floor is the backstop: whatever the
// deadbands swallow is written anyway within STATE_REFRESH_MS, so `at` stays
// meaningful and nothing can be silently stale for longer than that.
export const STATE_REFRESH_MS = 5 * 60 * 1000
const APOWER_DEADBAND_W = 0.5
const ENERGY_STEP_WH = 1
const TEMP_STEP_C = 1

// Null is a state, not a zero: gaining or losing a measurement is a change
// even when the number that appeared is tiny (`?? 0` would have read
// null -> 0.2 W as 0.2 W of jitter and swallowed it). Phrased as
// `!(|a-b| < step)` rather than `>=` so a NaN comparison — an unusable stored
// reading — comes out CHANGED; the deadbands must never be the reason a row
// silently stops being written.
const numChanged = (a, b, step) => (a == null) !== (b == null) || (a != null && !(Math.abs(a - b) < step))

export function stateChanged(prev, next) {
  if (!isObj(prev) || !isObj(next)) return true
  if (prev.online !== next.online || prev.output !== next.output || prev.source !== next.source) return true
  if (numChanged(prev.apower, next.apower, APOWER_DEADBAND_W)) return true
  if (numChanged(prev.aenergy_wh, next.aenergy_wh, ENERGY_STEP_WH)) return true
  if (numChanged(prev.temperature_c, next.temperature_c, TEMP_STEP_C)) return true
  // Either timestamp being unreadable means we cannot show the row is fresh,
  // so we write. Fail towards the extra write, never towards a row that
  // claims to be current and is not.
  const prevAt = Date.parse(prev.at ?? '')
  const nextAt = Date.parse(next.at ?? '')
  if (!Number.isFinite(prevAt) || !Number.isFinite(nextAt)) return true
  return nextAt - prevAt >= STATE_REFRESH_MS
}

// Takes one of our own normalised rows, not an API body — so this one DOES
// throw, and that is the point. Handed a reading (which carries `channels`,
// not `channel`) it would otherwise mint 'abc_undefined': a well-formed id
// that no device answers to, that never appears in the `failed` map the
// client returns, and that therefore gets recorded as a command successfully
// applied. A loud TypeError at the call site beats a switch that silently
// never moved.
export const groupId = (d) => {
  if (!d || !Number.isInteger(d.channel) || !d.device_id) throw new TypeError('groupId: expected a device row')
  return `${d.device_id}_${d.channel}`
}
