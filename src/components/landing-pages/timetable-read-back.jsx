'use client'

// PAGES.1 — how a typed-in timetable reads (parseManualTimetable): the class
// times by weekday and the lines it could not read, under the studio rows'
// timetable field (studio-offer-fields.jsx).
// Renders nothing for a blank timetable.

import { useMemo } from 'react'
import { parseManualTimetable } from '@/lib/manual-timetable'

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function TimetableReadBack({ text }) {
  const value = typeof text === 'string' ? text : ''
  const { slots, rejected } = useMemo(() => parseManualTimetable(value), [value])
  if (!value.trim()) return null
  const byDay = DAY_NAMES.map((name, i) => ({ name, times: slots.filter((s) => s.dow === i + 1) }))
    .filter((d) => d.times.length > 0)
  return (
    <div className="mt-2 rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-xs text-un1t-text space-y-1">
      {byDay.length === 0 ? (
        <p className="text-red-700">No class times could be read yet.</p>
      ) : (
        <>
          <p className="text-un1t-subtle">How it reads ({slots.length} class {slots.length === 1 ? 'time' : 'times'} a week):</p>
          {byDay.map((d) => (
            <p key={d.name}>
              <span className="font-medium">{d.name}</span>{' '}
              {d.times.map((s) => `${s.time} ${s.name}`).join(' · ')}
            </p>
          ))}
        </>
      )}
      {rejected.length > 0 && (
        <div className="text-red-700 pt-1">
          <p>Not understood, so not shown to visitors:</p>
          {rejected.map((line, i) => <p key={`${i}-${line}`} className="font-mono">{line}</p>)}
        </div>
      )}
    </div>
  )
}
