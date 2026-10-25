// src/components/schedule/DayHeader.jsx
'use client'

// ROSTERLOOK.1 — a week-view day header that also carries the day's staffing
// status and, for a manager, opens the Studio Overview for that day.
//
// This is where the Studio Overview strip went. The strip was a second row of
// seven tiles saying, in colliding capitals and an unexplained "4/1", roughly
// what the column under it already showed. The header says it with a dot and
// "1 short", and the full breakdown (events, bookable types, who is on leave,
// the undermanned shifts) is one click away in the SAME dialog the strip
// opened.
//
// A coach gets the plain header: `status` is null and there is no `onOpen`,
// because both the staffing status and the overview are manager surfaces.
//
// FOCUS. On click the button focuses ITSELF and hands its element to `onOpen`.
// Safari does not focus a button on click, and the Modal primitive returns
// focus to whatever document.activeElement was when it opened; without this a
// Safari operator closing the overview would land on the previously focused
// control (or the page), not on the day they opened. The element is also the
// caller's restoreFocusRef fallback.
//
// Children are <span>s, not <div>s: a <button> may only hold phrasing content.

import StatusDot from './StatusDot'

export default function DayHeader({ label, dayNumber, fullDate, isToday, holiday, status, onOpen }) {
  const headerCls = isToday
    ? 'bg-blue-600 text-white'
    : holiday
      ? 'bg-amber-500/15 text-amber-700 border border-amber-500/30'
      : 'bg-un1t-surface text-un1t-subtle'
  // `relative`: anchors any sr-only descendant to this header (see StatusDot).
  const cls = `relative block w-full text-center py-2 rounded-t-lg text-xs font-semibold ${headerCls}`

  const body = (
    <>
      <span className="block">{label}</span>
      <span className={`block text-lg font-bold ${isToday ? 'text-white' : 'text-un1t-text'}`}>{dayNumber}</span>
      {holiday && (
        <span className={`block mt-0.5 text-[10px] font-medium leading-tight px-1 truncate ${isToday ? 'text-white/80' : 'text-amber-700'}`}>
          {holiday.source === 'national' ? '🇮🇪 ' : '🏷 '}{holiday.name}
        </span>
      )}
      {status && status.tone !== 'none' && (
        <span className="mt-1 flex justify-center">
          <StatusDot status={status} />
        </span>
      )}
    </>
  )

  if (!onOpen) {
    return <div data-testid="day-header" className={cls} title={holiday?.name || undefined}>{body}</div>
  }
  return (
    <button
      type="button"
      data-testid="day-header"
      onClick={(e) => {
        e.currentTarget.focus()
        onOpen(e.currentTarget)
      }}
      aria-label={[fullDate, holiday?.name, status?.srLabel, 'Open studio overview'].filter(Boolean).join('. ')}
      title={holiday?.name || 'Open studio overview'}
      className={`${cls} cursor-pointer hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent`}
    >
      {body}
    </button>
  )
}
