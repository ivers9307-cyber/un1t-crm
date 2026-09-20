// src/components/schedule/MonthCell.jsx
'use client'

// ROSTERLOOK.1 — one day in the month grid.
//
// Was: "5:45am 2/10" three times and "+4 more", nobody named, under two
// badges ("!1", "↓1") that only made sense if you already knew. Now each line
// is a time and first names ("5:45 Alex, Blake"; monthCellLines decides
// the words), an unstaffed or short line takes the status colour, and the
// day's status is the SAME StatusDot the week headers use, with its sentence
// as a title and as visually hidden text.
//
// Lines are neutral (bg-un1t-bg on the cell's bg-un1t-surface): the template
// colour is no longer a tint here either.
//
// The cell is ONE <button> that drills into that week, so nothing interactive
// may be nested in it. "+N more" is therefore text: the drill-down is the
// expander, as it always was.
// For the same reason every child is a <span> (block where it needs to be):
// a <button> may only hold phrasing content.

import StatusDot from './StatusDot'

const LINE_TONE = {
  ok: 'text-un1t-text',
  quiet: 'text-un1t-subtle italic',
  short: 'text-amber-700 border border-amber-500/50',
  empty: 'text-red-700 border border-dashed border-red-500/50',
}

export default function MonthCell({ dayNumber, inFocusedMonth, isToday, holiday, lines, more, status, assignmentCount, timeOffEntry, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative text-left bg-un1t-surface border rounded-md p-1.5 min-h-[88px] transition-colors hover:border-un1t-text/30 ${
        inFocusedMonth ? 'border-un1t-border' : 'border-un1t-border/50 opacity-60'
      } ${isToday ? 'ring-1 ring-blue-400/50' : ''} ${holiday ? 'bg-amber-500/[0.06]' : ''}`}
    >
      <span className="flex items-center justify-between gap-1 mb-1">
        <span className={`text-xs font-semibold ${isToday ? 'text-blue-700' : inFocusedMonth ? 'text-un1t-text' : 'text-un1t-muted'}`}>
          {dayNumber}
        </span>
        <span className="flex items-center gap-1">
          <StatusDot status={status} />
          {assignmentCount > 0 && (
            <span
              data-testid="month-assignment-count"
              className="relative text-[10px] px-1.5 py-0.5 rounded bg-un1t-border/60 text-un1t-subtle"
              title={`${assignmentCount} coach assignment${assignmentCount === 1 ? '' : 's'}`}
            >
              {assignmentCount}
              <span className="sr-only"> coach assignment{assignmentCount === 1 ? '' : 's'}</span>
            </span>
          )}
        </span>
      </span>
      {holiday && (
        <span className="block text-[9px] text-amber-700 mb-1 truncate" title={holiday.name}>
          {holiday.name}
        </span>
      )}
      <span className="block space-y-0.5">
        {lines.map((line) => (
          <span
            key={line.id}
            data-testid="month-line"
            data-tone={line.tone}
            title={line.title}
            className={`block text-[10px] truncate rounded px-1 py-0.5 bg-un1t-bg ${LINE_TONE[line.tone] || LINE_TONE.ok}`}
          >
            {line.text}
          </span>
        ))}
        {more > 0 && <span className="block text-[10px] text-un1t-subtle">+{more} more</span>}
        {timeOffEntry && (
          <span
            className="block text-[10px] truncate rounded px-1 py-0.5"
            style={{ backgroundColor: timeOffEntry.color + '18', color: timeOffEntry.color }}
          >
            {timeOffEntry.text}
          </span>
        )}
      </span>
    </button>
  )
}
