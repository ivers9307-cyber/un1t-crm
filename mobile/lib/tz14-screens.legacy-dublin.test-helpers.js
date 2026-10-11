// TZ.14 — the phone's pre-TZ.14 Dublin-pinned expressions, frozen UNCHANGED
// for the byte-identity tests (studio-zone.tz.test.js, member/member-zone.tz.test.js,
// dates.tz14.test.js). TZ.18b deletes this file once the wave has merged.
// Each export is the exact expression the named screen ran before TZ.14.

import { dublinDateKey, dublinWeekStartMs, DUBLIN_DAY_MS } from 'shared/dublin-time'

// mobile/app/(member)/(tabs)/home.jsx:122-125 (digest window)
export function lastWeekWindowLegacy(nowMs) {
  const thisWeekStartMs = dublinWeekStartMs(nowMs)
  const lastWeekStartIso = new Date(dublinWeekStartMs(thisWeekStartMs - DUBLIN_DAY_MS)).toISOString()
  const thisWeekStartIso = new Date(thisWeekStartMs).toISOString()
  return { thisWeekStartMs, thisWeekStartIso, lastWeekStartIso }
}

// mobile/app/(member)/(tabs)/home.jsx:335 (this-week pips)
export const thisWeekStartMsLegacy = (nowMs) => dublinWeekStartMs(nowMs)

// mobile/app/(member)/(tabs)/home.jsx:542-560
export function mostFrequentWeekdayLegacy(sessions) {
  const counts = new Array(7).fill(0)
  let any = false
  for (const s of sessions || []) {
    const iso = s.started_at || s.ended_at
    if (!iso) continue
    const [y, m, d] = dublinDateKey(iso).split('-').map(Number)
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    counts[dow]++
    any = true
  }
  if (!any) return null
  let bestIdx = 0
  for (let i = 1; i < 7; i++) if (counts[i] > counts[bestIdx]) bestIdx = i
  if (counts[bestIdx] < 2) return null
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][bestIdx]
}

// mobile/app/(member)/(tabs)/sessions.jsx:209-214 + :301-305, sessions/[id].jsx:303-305
export function memberClockLabelLegacy(startedAt) {
  return startedAt
    ? new Intl.DateTimeFormat('en-IE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' }).format(new Date(startedAt))
    : null
}

// mobile/app/(staff)/contracts/[id].jsx:63-70
export function contractDetailFmtDateLegacy(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// mobile/app/(staff)/contracts/index.jsx:24-30 (and policies/index.jsx, policies/[slug].jsx: same body)
export function dateFmtLegacy(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// mobile/components/AcDeviceList.jsx:61-69
export function asOfLabelLegacy(iso) {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  return t.toLocaleTimeString('en-IE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
  })
}

// mobile/lib/invoice-review.js:53-58
export function invoiceFormatDayLegacy(iso) {
  if (!iso) return 'an unknown date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an unknown date'
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Dublin' })
}

// mobile/lib/dates.js:92-120 (dublinTodayIso, Intl path)
export function dublinTodayIsoLegacy(now = new Date()) {
  const parts = {}
  for (const p of new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)) parts[p.type] = p.value
  return `${parts.year}-${parts.month}-${parts.day}`
}
