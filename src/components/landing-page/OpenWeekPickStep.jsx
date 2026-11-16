'use client'

// OpenWeekPickStep — OPENWEEK.1: the class step of an open week card. Every
// bookable slot of the window, grouped by day; the visitor taps several, up to
// `maxClasses` in all and `maxPerDay` on one day (with one a day, a tap on a
// day that already has a pick moves the pick). A tap past the limit is refused
// with the hint shown as the reason. The server judges the same limits again.
// The words are the corp_promo block's (pick_heading, pick_hint, pick_cta with
// {count}) and the class step's empty-state words.
import { useState } from 'react'
import { cadenceGroups, PICK_CTA_CLS } from './ClassPickStep'
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
 * @param {{ list: { classes: object[], loading: boolean, unavailable: boolean },
 *   copy: object, maxClasses: number, maxPerDay: number, picks: object[],
 *   onChange: (picks: object[]) => void, onContinue: () => void, error?: string|null }} props
 */
export default function OpenWeekPickStep({ list, copy, maxClasses, maxPerDay, picks, onChange, onContinue, error = null }) {
  const [refusal, setRefusal] = useState(null)
  const groups = cadenceGroups(list.classes)
  const picked = new Set(picks.map((p) => p.event_id))
  const tap = (cls) => {
    const r = togglePick(picks, cls, { maxClasses, maxPerDay })
    if (r.refused) { setRefusal(copy.pick_hint); return }
    setRefusal(null)
    onChange(r.picks)
  }
  const cta = String(copy.pick_cta || 'Continue').replace('{count}', String(picks.length))

  return (
    <div>
      <h2 className="font-display font-extrabold uppercase text-2xl leading-tight text-black">{copy.pick_heading}</h2>
      <p className="mt-2 text-sm text-black/70">{copy.pick_hint}</p>
      <div className="mt-4 space-y-4">
        {list.loading ? (
          <p className="text-black/70 text-lg py-4" role="status">Loading classes…</p>
        ) : list.unavailable ? (
          <p className="text-black/70 text-lg py-4" role="status">{copy.timetable_unavailable_text}</p>
        ) : groups.length === 0 ? (
          <p className="text-black/70 text-lg py-4" role="status">{copy.no_classes_text}</p>
        ) : groups.map((g) => (
          <div key={g.day}>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-black/60 mb-1.5">{g.day_label}</div>
            <div className="flex flex-wrap gap-2">
              {g.classes.map((cls) => {
                const on = picked.has(cls.event_id)
                return (
                  <button
                    key={cls.event_id}
                    type="button"
                    data-slot={cls.event_id}
                    aria-pressed={on}
                    onClick={() => tap(cls)}
                    className={`rounded-full px-4 py-2 text-sm transition ${on ? 'bg-black text-white' : 'bg-white border border-black/15 text-black hover:border-black/40'}`}
                  >
                    <span className="font-bold">{cls.time}</span> · {cls.name}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {(refusal || error) && <p className={`${TRIAL_ERROR} mt-4`} role="alert">{refusal || error}</p>}
      <button type="button" onClick={() => onContinue()} disabled={picks.length === 0} className={`${PICK_CTA_CLS} mt-5`}>{cta}</button>
    </div>
  )
}
