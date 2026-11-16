'use client'

// OpenWeekPickStep — OPENWEEK.1: the class step of an open week card. The
// whole week at a glance (OPENWEEK.3): one compact row per day, the day's
// class named once and each slot a time-only pill (a class other than the
// day's main one is outlined dashed and named in the row). Every bookable
// slot of the window; the visitor taps several, up to
// `maxClasses` in all and `maxPerDay` on one day (with one a day, a tap on a
// day that already has a pick moves the pick). A tap past the limit is refused
// with the hint shown as the reason. The server judges the same limits again.
// The words are the corp_promo block's (pick_heading, pick_hint, pick_cta with
// {count}) and the class step's empty-state words.
import { useState } from 'react'
import { cadenceGroups, labelParts, PICK_CTA_CLS } from './ClassPickStep'
import { TRIAL_ERROR } from './trial-card'

/**
 * The picks after tapping `cls`. Pure.
 * @returns {{ picks: object[], refused: null|'too_many'|'day_full' }}
 */
export function togglePick(picks, cls, { maxClasses, maxPerDay }) {
  const current = Array.isArray(picks) ? picks : []
  if (current.some((p) => p.event_id === cls.event_id)) {
    return { picks: current.filter((p) => p.event_id !== cls.event_id), refused: null }
  }
  const sameDay = current.filter((p) => p.day === cls.day)
  if (sameDay.length >= maxPerDay) {
    if (maxPerDay !== 1) return { picks: current, refused: 'day_full' }
    return { picks: [...current.filter((p) => p.day !== cls.day), cls], refused: null }
  }
  if (current.length >= maxClasses) return { picks: current, refused: 'too_many' }
  return { picks: [...current, cls], refused: null }
}

/**
 * The window's slots as one row per day, in day order. `main` is the day's
 * most common class name (ties: the earliest); `label` names it, then every
 * other class with its time; each slot carries `special` (not the main class).
 * Pure.
 */
export function dayRows(classes) {
  return cadenceGroups(classes).map((g) => {
    const counts = new Map()
    for (const c of g.classes) counts.set(c.name, (counts.get(c.name) || 0) + 1)
    let main = g.classes[0]?.name || ''
    for (const c of g.classes) if ((counts.get(c.name) || 0) > (counts.get(main) || 0)) main = c.name
    const others = g.classes.filter((c) => c.name !== main).map((c) => `${c.name} ${c.time}`)
    return {
      day: g.day,
      day_label: g.day_label,
      main,
      label: [main, ...others].join(' · '),
      classes: g.classes.map((c) => ({ ...c, special: c.name !== main })),
    }
  })
}

/**
 * @param {{ list: { classes: object[], loading: boolean, unavailable: boolean },
 *   copy: object, maxClasses: number, maxPerDay: number, picks: object[],
 *   onChange: (picks: object[]) => void, onContinue: () => void, error?: string|null }} props
 */
export default function OpenWeekPickStep({ list, copy, maxClasses, maxPerDay, picks, onChange, onContinue, error = null }) {
  const [refusal, setRefusal] = useState(null)
  const rows = dayRows(list.classes)
  const picked = new Set(picks.map((p) => p.event_id))
  const tap = (slot) => {
    // The row's `special` flag is display only: picks stay the listed class.
    const { special: _special, ...cls } = slot
    const r = togglePick(picks, cls, { maxClasses, maxPerDay })
    if (r.refused) { setRefusal(copy.pick_hint); return }
    setRefusal(null)
    onChange(r.picks)
  }
  const cta = String(copy.pick_cta || 'Continue').replace('{count}', String(picks.length))

  return (
    <div>
      <h2 className="font-display font-extrabold uppercase text-2xl leading-tight text-black">{copy.pick_heading}</h2>
      <p className="mt-1 text-sm text-black/70">{copy.pick_hint}</p>
      <div className="mt-3">
        {list.loading ? (
          <p className="text-black/70 text-lg py-4" role="status">Loading classes…</p>
        ) : list.unavailable ? (
          <p className="text-black/70 text-lg py-4" role="status">{copy.timetable_unavailable_text}</p>
        ) : rows.length === 0 ? (
          <p className="text-black/70 text-lg py-4" role="status">{copy.no_classes_text}</p>
        ) : rows.map((row) => {
          const [weekday, dateNumber = '', ...rest] = labelParts(row.day_label)
          return (
            <div key={row.day} role="group" aria-label={row.day_label} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 py-2 border-t border-black/10">
              <div className="text-xs leading-tight text-black/60">
                <span className="block text-sm font-bold text-black">{weekday}</span>
                {dateNumber} {rest.join(' ')}
              </div>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-black/60 mb-1 truncate">{row.label}</p>
                <div className="flex flex-wrap gap-1">
                  {row.classes.map((cls) => {
                    const on = picked.has(cls.event_id)
                    return (
                      <button
                        key={cls.event_id}
                        type="button"
                        data-slot={cls.event_id}
                        aria-pressed={on}
                        aria-label={`${cls.time} ${cls.name}`}
                        title={cls.name}
                        onClick={() => tap(cls)}
                        className={`rounded-full px-2.5 py-1 text-xs tabular-nums transition border ${cls.special ? 'border-dashed' : ''} ${on ? 'bg-black text-white border-black' : 'bg-white text-black border-black/25 hover:border-black/50'}`}
                      >
                        {cls.time}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {(refusal || error) && <p className={`${TRIAL_ERROR} mt-3`} role="alert">{refusal || error}</p>}
      <div className="mt-3 pt-3 border-t border-black/10 flex items-center justify-between gap-3">
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: maxClasses }, (_, i) => (
            <span key={i} data-dot={i < picks.length ? 'on' : 'off'} className={`h-2 w-2 rounded-full ${i < picks.length ? 'bg-black' : 'bg-black/20'}`} />
          ))}
        </div>
        <button type="button" onClick={() => onContinue()} disabled={picks.length === 0} className={`${PICK_CTA_CLS} !w-auto !py-3 px-5 text-sm`}>{cta}</button>
      </div>
    </div>
  )
}
