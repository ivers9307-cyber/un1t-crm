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

export function normaliseGetItem(item) {
  if (!isObj(item)) return null
  // MACs arrive as strings; a number id is tolerated, anything else (object,
  // array, blank) is not an id and the row is dropped rather than becoming
  // '[object object]' or ''.
  const rawId = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).trim() : ''
  if (!rawId) return null
  const status = isObj(item.status) ? item.status : {}
  const online = item.online === 1 || item.online === true
  const gen = parseGen(item.gen)
  const channels = switchChannels(status)
  return {
    device_id: rawId.toLowerCase(),
    online, gen,
    model: str(item.code) ?? str(item.type) ?? null,
    // The cron's `select` is ['status'] only, so `settings` — and with it the
    // device name — is absent on almost every read. Discovery asks for
    // ['status','settings']; everywhere else null here is the normal case,
    // not a failure.
    name: nameFrom(item.settings, item.name),
    channels,
    ...supportFor({ gen, status, channels, statusKeys: Object.keys(status) }),
  }
}

export function normaliseGetItems(body) {
  const list = Array.isArray(body) ? body
    : Array.isArray(body?.devices) ? body.devices
    : Array.isArray(body?.data) ? body.data : []
  return list.map(normaliseGetItem).filter(Boolean)
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
      name: nameFrom(e, null),
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
