// Pure event helpers shared by web (src/app/events) and mobile
// (mobile/app/events). Kept here so the kind labels/tones + the
// upcoming/past split can't drift between platforms. Pure — no DB,
// no network, no platform imports — so it unit-tests under Node and
// imports cleanly into the RN bundle.

// The multi-kind set from mig 122. `race` is the original/default kind.
export const EVENT_KINDS = ['race', 'workshop', 'seminar', 'open_day', 'masterclass', 'lead_gen']

// label + a SEMANTIC tone per kind. Each platform maps the tone to its
// own colour classes (web Tailwind vs mobile NativeWind) so the palette
// stays one decision here.
const KIND_META = {
  race:        { label: 'Race',        tone: 'emerald' },
  workshop:    { label: 'Workshop',    tone: 'sky' },
  seminar:     { label: 'Seminar',     tone: 'indigo' },
  open_day:    { label: 'Open day',    tone: 'amber' },
  masterclass: { label: 'Masterclass', tone: 'pink' },
  lead_gen:    { label: 'Lead Gen',    tone: 'teal' },
}

// Unknown/null kinds fall back to race — matches the web list's
// `kindBadge(r.kind || 'race')` default.
function meta(kind) {
  return KIND_META[kind] || KIND_META.race
}

export function eventKindLabel(kind) {
  return meta(kind).label
}

export function eventKindTone(kind) {
  return meta(kind).tone
}

export function isRaceKind(kind) {
  return (kind || 'race') === 'race'
}

/**
 * Split events into upcoming vs past against a YYYY-MM-DD "today" and
 * sort each block for a browse list: upcoming ascending (nearest first),
 * past descending (most recent first). An event with no race_date counts
 * as upcoming so a half-created event isn't hidden. Pure — the caller
 * supplies `today` (compute it in the operator's timezone server-side).
 * @param {Array<{race_date?: string|null}>} events
 * @param {string} today  YYYY-MM-DD
 * @returns {{upcoming: Array, past: Array}}
 */
export function orderEventsForBrowse(events, today) {
  const list = Array.isArray(events) ? events : []
  const upcoming = list
    .filter((e) => !e?.race_date || e.race_date >= today)
    .sort((a, b) => (a?.race_date || '').localeCompare(b?.race_date || ''))
  const past = list
    .filter((e) => e?.race_date && e.race_date < today)
    .sort((a, b) => (b?.race_date || '').localeCompare(a?.race_date || ''))
  return { upcoming, past }
}
