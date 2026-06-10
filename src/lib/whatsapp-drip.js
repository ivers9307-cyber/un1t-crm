// src/lib/whatsapp-drip.js
// Pure helpers + tunables for the WhatsApp drip broadcast engine (WA-DRIP). No IO
// — unit-tested in whatsapp-drip.test.js. The IO engine (sendDripChunk) lives in
// whatsapp.js and composes these. Client-safe (UI imports estimateDripDays).

// Per-tick send ceiling. A drip's daily_cap drains over several morning ticks
// rather than one burst: at 100/tick + a 15-min cron, a 500/day cap is spent in
// ~5 ticks (~75 min) then idles until the rolling-24h window frees capacity.
export const PER_TICK_MAX = 100

// Auto-pause a drip after this many CONSECUTIVE send failures in one tick. An
// unattended drip runs for days, so a quality-collapse or expired token must stop
// the bleed rather than drain the whole list into failures. (The blast
// sendBroadcast does NOT do this — verified against src/lib/whatsapp.js.)
export const AUTO_PAUSE_CONSECUTIVE_FAILURES = 5

// 'HH:MM' or 'HH:MM:SS' → minutes since local midnight.
function parseHHMM(value) {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

// Minutes-since-local-midnight of `date` in IANA `tz`. DST-safe: Intl resolves the
// correct wall-clock for the instant (Europe/Dublin BST vs GMT included).
// hourCycle:'h23' guarantees 00-23 (no '24' at midnight).
function localMinutesOfDay(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const h = Number(parts.find(p => p.type === 'hour').value)
  const m = Number(parts.find(p => p.type === 'minute').value)
  return h * 60 + m
}

// Is `now` within [start, end) local time-of-day in `tz`? Daytime windows
// (start < end) in practice; a wrap-past-midnight window is handled defensively.
export function isWithinSendWindow(now, { start, end, tz }) {
  const mins = localMinutesOfDay(now, tz)
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  if (s === e) return false              // zero-length window — never send
  if (s < e) return mins >= s && mins < e
  return mins >= s || mins < e           // wraps midnight
}

// How many more we may send in the current rolling-24h window.
export function rollingHeadroom(dailyCap, sentLast24h) {
  return Math.max(0, dailyCap - sentLast24h)
}

// Whole-days estimate to finish the remaining audience at dailyCap/day (ETA).
export function estimateDripDays(remaining, dailyCap) {
  if (remaining <= 0) return 0
  if (dailyCap <= 0) return Infinity
  return Math.ceil(remaining / dailyCap)
}

// Pick this tick's recipients: eligible audience minus already-processed, capped
// to min(headroom, perTickMax). `exhausted` means this batch finishes the list
// (or there was nothing left) — note headroom===0 yields an empty batch that is
// NOT exhaustion (there's capacity-wait, not completion).
export function selectDripRecipients({ audience, doneIds, headroom, perTickMax = PER_TICK_MAX }) {
  const done = new Set(doneIds)
  const remaining = audience.filter(c => !done.has(c.id))
  const cap = Math.max(0, Math.min(headroom, perTickMax))
  const toSend = remaining.slice(0, cap)
  return { toSend, remainingCount: remaining.length, exhausted: remaining.length <= toSend.length }
}

// Decide the broadcast's post-tick row state. autoPaused beats everything (we hit
// the consecutive-failure guard — stay 'sending' but stamp paused_at so the cron
// skips it until an operator resumes); else exhausting the audience finalises to
// 'sent'; else stay 'sending' for the next tick.
export function dripOutcome({ autoPaused, exhausted }, nowIso) {
  if (autoPaused) return { status: 'sending', paused_at: nowIso }
  if (exhausted) return { status: 'sent', sent_at: nowIso, paused_at: null }
  return { status: 'sending' }
}
