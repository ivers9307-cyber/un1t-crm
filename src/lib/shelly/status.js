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
//     when the body actually showed us a status to judge. An empty or absent
//     status (normal for an offline device, and possible for an online one
//     given the shapes above are unverified) is `supported:null` = "ask
//     again later", not "this is a 3EM".

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

function switchChannels(status) {
  const out = []
  for (const key of Object.keys(isObj(status) ? status : {})) {
    const m = key.match(/^switch:(\d+)$/)
    if (m) out.push(channelFromSwitch(Number(m[1]), status[key]))
  }
  return out.sort((a, b) => a.channel - b.channel)
}

// `statusKeys` is the caller's answer to "did the body show us a status at
// all", NOT `Object.keys(status)` — the v1 entry always carries at least the
// `_dev_info` wrapper Shelly Cloud injects, so counting raw keys there would
// quietly defeat rule 2 for every offline v1 device.
function supportFor({ gen, status, channels, statusKeys }) {
  if ((gen != null && gen < 2) || Array.isArray(status?.relays) || Array.isArray(status?.meters)) {
    return { supported: false, reason: 'gen1' }
  }
  if (channels.length) return { supported: true }
  // A real component list with no `switch:*` in it — a Pro 3EM (`em:0`), an
  // H&T. That is evidence, so it is a verdict.
  if (statusKeys.length) return { supported: false, reason: 'no_switch' }
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

export function stateChanged(prev, next) {
  if (!isObj(prev) || !isObj(next)) return true
  if (prev.online !== next.online || prev.output !== next.output || prev.source !== next.source) return true
  if (Math.abs((next.apower ?? 0) - (prev.apower ?? 0)) >= APOWER_DEADBAND_W) return true
  if (Math.abs((next.aenergy_wh ?? 0) - (prev.aenergy_wh ?? 0)) >= ENERGY_STEP_WH) return true
  if (Math.abs((next.temperature_c ?? 0) - (prev.temperature_c ?? 0)) >= TEMP_STEP_C) return true
  // Either timestamp being unreadable means we cannot show the row is fresh,
  // so we write. Fail towards the extra write, never towards a row that
  // claims to be current and is not.
  const prevAt = Date.parse(prev.at ?? '')
  const nextAt = Date.parse(next.at ?? '')
  if (!Number.isFinite(prevAt) || !Number.isFinite(nextAt)) return true
  return nextAt - prevAt >= STATE_REFRESH_MS
}

// Takes one of our own normalised rows, not an API body.
export const groupId = (d) => `${d.device_id}_${d.channel}`
