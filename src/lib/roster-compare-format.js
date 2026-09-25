// src/lib/roster-compare-format.js
// SNAPSHOT.1 — the words for the "Published vs now" view. PURE and client-safe:
// no imports and no IO. Calendar dates are built from their parts (the host
// zone cannot move them); publish instants are read in Europe/Dublin through
// Intl's NUMERIC parts, which do not vary with the ICU month-name data.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MINUS = '−'

export const COMPARE_CHANGE_LABELS = Object.freeze({
  unchanged: 'Unchanged',
  moved: 'Moved',
  added: 'Added after publish',
  removed: 'Removed after publish',
})

// House chip rule: -500/10 background, -700 text.
export const COMPARE_CHANGE_CHIP = Object.freeze({
  unchanged: 'bg-slate-500/10 text-slate-700',
  moved: 'bg-amber-500/10 text-amber-700',
  added: 'bg-blue-500/10 text-blue-700',
  removed: 'bg-red-500/10 text-red-700',
})

export const ARRIVAL_CAVEAT =
  'Arrival stamps come from phone check-ins and door taps and are missing for many shifts, so "No arrival recorded" is a prompt to check, not a no-show.'

/** '2026-09-15' -> 'Tue 15 Sep'; '' for anything else. */
export function dayLabel(dateIso) {
  const m = String(dateIso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return `${DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}

export function periodLabel(start, end) {
  return start === end ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(end)}`
}

const DUBLIN_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function dublinParts(iso) {
  const ms = Date.parse(iso || '')
  if (!Number.isFinite(ms)) return null
  const p = {}
  for (const { type, value } of DUBLIN_PARTS.formatToParts(new Date(ms))) p[type] = value
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` }
}

/** A publish instant as the studio reads it: 'Sat 12 Sep, 14:02'. */
export function publishedLabel(iso) {
  const p = dublinParts(iso)
  return p ? `${dayLabel(p.date)}, ${p.time}` : ''
}

export function windowLabel(w) {
  return w?.start && w?.end ? `${w.start}–${w.end}` : '—'
}

export function hoursLabel(h) {
  return `${(Math.round((Number(h) || 0) * 10) / 10).toFixed(1)}h`
}

export function deltaLabel(h) {
  const n = Math.round((Number(h) || 0) * 10) / 10
  if (n === 0) return 'no change'
  return `${n > 0 ? '+' : MINUS}${Math.abs(n).toFixed(1)}h`
}

export function totalsSentence(t) {
  return `Published ${hoursLabel(t?.published_hours)} · now ${hoursLabel(t?.current_hours)} (${deltaLabel(t?.hours_delta)})`
}

export function changeCountsSentence(t) {
  const parts = [
    [t?.moved, 'moved'],
    [t?.added, 'added after publish'],
    [t?.removed, 'removed after publish'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)
  return parts.length ? parts.join(' · ') : 'No coach changes since this publish'
}

export function arrivalSentence(t) {
  if (!t || !t.ended) return null
  const base = `Arrival recorded for ${t.arrived} of ${t.ended} ended shift${t.ended === 1 ? '' : 's'}`
  return t.arrived_inferred ? `${base} (${t.arrived_inferred} carried from the shift before)` : base
}

export function compareRowSummary(r) {
  if (r.change === 'moved') return `${windowLabel(r.published)} → ${windowLabel(r.current)}`
  if (r.change === 'removed') return `was ${windowLabel(r.published)}`
  if (r.change === 'added') return `now ${windowLabel(r.current)}`
  return windowLabel(r.current)
}

export function arrivalLabel(r) {
  if (r.arrived_local) return r.arrival_inferred ? `Arrived ${r.arrived_local} (on site from the shift before)` : `Arrived ${r.arrived_local}`
  if (r.no_show_candidate) return 'No arrival recorded'
  return null
}

const BRIEFING_NOTES = Object.freeze({
  added: 'Briefing added after publish',
  changed: 'Briefing changed after publish',
  removed: 'Briefing removed after publish',
})

export function blockChangeNotes(b) {
  const notes = []
  if (b.change === 'moved') notes.push(`Shift moved from ${windowLabel(b.published)}`)
  if (b.change === 'added') notes.push('Shift added after publish')
  if (b.change === 'removed') notes.push('Shift removed after publish')
  if (b.staffing_changed && b.published && b.current) {
    notes.push(`Coaches needed ${b.published.min}–${b.published.max}, now ${b.current.min}–${b.current.max}`)
  }
  // BLOCKEDIT.1's briefing: the snapshot keeps a fingerprint, never the text,
  // so the note says what kind of change it was, exactly as the change log does.
  if (BRIEFING_NOTES[b.briefing_change]) notes.push(BRIEFING_NOTES[b.briefing_change])
  return notes
}

/** No backfill (SNAPSHOT.1 D11): why there is nothing to compare. */
export function missingSnapshotMessage({ missing_reason: reason, snapshots_began_at: beganAt } = {}) {
  if (reason === 'not_saved') {
    return 'The record of this publish could not be saved at the time, so there is nothing to compare it with. The next publish of this period will be recorded.'
  }
  const began = dublinParts(beganAt)
  if (began) {
    return `Published vs now is available for rosters published from ${dayLabel(began.date)}. This roster was published before then.`
  }
  return 'Published vs now starts with the next publish at this studio. Rosters published before it have no record of what was published.'
}

export function publishOptionLabel(p, rosterId) {
  const base = `${publishedLabel(p.published_at)} · ${periodLabel(p.period_start, p.period_end)}`
  return p.roster_id === rosterId ? `${base} (this roster)` : base
}

/**
 * The published rosters the period's shifts sit on, earliest first: what the
 * change-log dialog compares. Reads the blocks feed rows the calendar already
 * holds (`roster_id` + `rosters: { status }`), so it costs no request.
 */
export function publishedRosterIdsIn(blocks, from, to) {
  const firstDay = new Map()
  for (const b of blocks || []) {
    if (!b?.roster_id || b.rosters?.status !== 'published') continue
    if (b.block_date < from || b.block_date > to) continue
    const seen = firstDay.get(b.roster_id)
    if (!seen || b.block_date < seen) firstDay.set(b.roster_id, b.block_date)
  }
  return [...firstDay.entries()]
    .sort((x, y) => x[1].localeCompare(y[1]) || x[0].localeCompare(y[0]))
    .map(([id]) => id)
}

function quietCoach(r) {
  return r.change === 'unchanged' && !r.no_show_candidate
}

/** Unchanged shifts and coaches hidden unless asked for. */
export function visibleCompareBlocks(blocks, showUnchanged) {
  if (showUnchanged) return blocks || []
  return (blocks || []).flatMap((b) => {
    const coaches = (b.coaches || []).filter((r) => !quietCoach(r))
    const blockNews = b.change !== 'unchanged' || b.staffing_changed || Boolean(b.briefing_change)
    return blockNews || coaches.length > 0 ? [{ ...b, coaches }] : []
  })
}
