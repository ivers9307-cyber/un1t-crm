'use client'

// GRID.1 — the manager's coach-by-day grid: Schedule → Week → Coaches.
//
// An ADDITIONAL layout, not a replacement: the day-column cards stay the
// default (the ROSTER LOOK decision). One row per coach at this studio, then
// three numbers (the week's hours across every studio of the organisation,
// the contract for employees, and the admin balance = contract − class −
// placed admin, program default 4), then seven day columns. The numbers sit
// next to the name so they are on screen without scrolling. Hours only:
// nothing here is, or can be turned into, pay.
//
// READ-ONLY. A shift at this studio is a button that opens the same block
// dialog a day card opens (in select mode it toggles selection, as a card
// does: the calendar decides, in onOpenBlock). A shift at another studio is a
// muted marker, not a control: that studio's dialog is not this screen's to
// open. No drag-and-drop (GRID.1 plan, review notes).
//
// Every decision is in src/lib/roster-grid-model.js (pure, tested). This file
// lays it out. 🔴 jsdom cannot see layout: the sticky first column, the
// horizontal scroller and the 1280/390 widths are browser checks (PR body).
//   - The scroller is `relative overflow-x-auto` for the week grid's reason
//     (ROSTERLOOK.1): it must be the containing block of every sr-only span,
//     or they stretch the DOCUMENT sideways on a phone.
//   - `border-separate border-spacing-0`, not `border-collapse`: a sticky cell
//     in a collapsed-border table loses its borders while it scrolls.
//   - Sticky cells carry their own background, or the day columns show
//     through them as they scroll underneath.

import { CalendarOff, CalendarX } from 'lucide-react'
import { hoursMinutesLabel, MAX_WEEK_HOURS, MIN_REST_HOURS } from '@shared/working-time'
import { adminBalanceLabel, restGapTitle, untimedLabel, GRID_COPY } from '@/lib/roster-grid-model'
import { indexByDate } from '@/lib/bank-holidays'
import ScheduleErrorBanner from './ScheduleErrorBanner'

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const TONE = {
  to_place: 'text-un1t-text',
  met: 'text-green-700',
  over: 'text-amber-700 font-semibold',
  none: 'text-un1t-muted',
}
const HEAD = 'border-b border-un1t-border px-2 py-2 font-semibold text-un1t-subtle whitespace-nowrap'
const CELL = 'border-b border-un1t-border px-2 py-2 align-top'
const NOTE = 'mb-2 text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-700'
const hoursOrZero = (m) => (m > 0 ? hoursMinutesLabel(m) : '0h')

export default function RosterGrid({
  model, loading = false, error = null, onRetry, onOpenBlock, canOpenBlock = () => true,
  selectMode = false, selectedBlockIds = null, onlyProfileId = null, holidays = [],
  leaveMissing = false, availabilityMissing = false,
}) {
  if (!model) {
    if (error) return <ScheduleErrorBanner title="Could not load the coach grid" message={error} onRetry={onRetry} busy={loading} />
    return (
      <div data-testid="roster-grid-loading" className="text-center py-20 text-un1t-subtle">
        {loading ? 'Loading coaches…' : 'Nothing to show for this week.'}
      </div>
    )
  }
  const rows = onlyProfileId ? model.rows.filter((r) => r.profile_id === onlyProfileId) : model.rows
  const holidayByDate = indexByDate(holidays)
  const selected = selectedBlockIds instanceof Set ? selectedBlockIds : new Set()

  return (
    <section data-testid="roster-grid" aria-label="Coaches by day">
      {error && (
        <ScheduleErrorBanner
          title="Could not refresh the coach grid"
          message={`${error} Showing the last grid that loaded.`}
          onRetry={onRetry}
          busy={loading}
        />
      )}
      {!model.checked && <p className={NOTE}>{GRID_COPY.crossStudioUnchecked}</p>}
      {leaveMissing && <p className={NOTE}>{GRID_COPY.leaveMissing}</p>}
      {availabilityMissing && <p className={NOTE}>{GRID_COPY.availabilityMissing}</p>}

      <div data-testid="roster-grid-scroller" className="relative overflow-x-auto rounded-lg border border-un1t-border">
        <table className="min-w-[1180px] w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="bg-un1t-surface text-left">
              <th scope="col" data-testid="roster-grid-corner" className={`${HEAD} sticky left-0 z-20 w-36 sm:w-44 bg-un1t-surface border-r`}>Coach</th>
              <th scope="col" className={`${HEAD} text-right`}>Week</th>
              <th scope="col" className={`${HEAD} text-right`}>Contract</th>
              <th scope="col" className={`${HEAD} text-right border-r`}>Admin balance</th>
              {model.days.map((date, i) => {
                const holiday = holidayByDate.get(date)
                return (
                  <th key={date} scope="col" className={`${HEAD} min-w-[7.5rem]`} title={holiday?.name || undefined}>
                    {DAY_LABELS[i]} {Number(date.slice(8, 10))}
                    {holiday && <span className="ml-1 font-normal text-amber-700">· {holiday.name || 'Bank holiday'}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className={`${CELL} py-8 text-center text-un1t-muted`}>{GRID_COPY.noRows}</td>
              </tr>
            ) : rows.map((row) => (
              <GridRow
                key={row.profile_id}
                row={row}
                onOpenBlock={onOpenBlock}
                canOpenBlock={canOpenBlock}
                selectMode={selectMode}
                selected={selected}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] text-un1t-muted">
        {GRID_COPY.legend} Flags (employees): over {MAX_WEEK_HOURS} hours in a week, under {MIN_REST_HOURS} hours between working days.
        {model.untimed > 0 && ` ${untimedLabel(model.untimed)}.`}
      </p>
    </section>
  )
}

function GridRow({ row, onOpenBlock, canOpenBlock, selectMode, selected }) {
  const balance = adminBalanceLabel(row)
  const shortestRest = row.restGaps.length ? Math.min(...row.restGaps.map((g) => g.rest_minutes)) : null
  return (
    <tr data-testid="roster-grid-row" data-profile-id={row.profile_id}>
      <th scope="row" className={`${CELL} sticky left-0 z-10 w-36 sm:w-44 bg-un1t-bg border-r text-left font-medium text-un1t-text`}>
        <div className="truncate" title={row.full_name}>{row.full_name}</div>
        {!row.member && <div className="text-[11px] font-normal text-un1t-muted">Not on this studio’s team now</div>}
        {(row.longWeekMinutes !== null || shortestRest !== null) && (
          <div className="mt-1 flex flex-wrap gap-1 font-normal">
            {row.longWeekMinutes !== null && (
              <span
                data-testid="grid-long-week"
                title={`Over ${MAX_WEEK_HOURS} hours rostered this week, every studio counted`}
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 whitespace-nowrap"
              >
                {hoursMinutesLabel(row.longWeekMinutes)} week
              </span>
            )}
            {shortestRest !== null && (
              <span
                data-testid="grid-short-rest"
                title={row.restGaps.map(restGapTitle).join('; ')}
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 whitespace-nowrap"
              >
                {hoursMinutesLabel(shortestRest)} rest
              </span>
            )}
          </div>
        )}
      </th>
      <td data-testid="grid-week-total" className={`${CELL} text-right tabular-nums whitespace-nowrap`}>
        <div className="font-medium text-un1t-text">{hoursOrZero(row.totals.minutes)}</div>
        {row.totals.elsewhere_minutes > 0 && (
          <div className="text-[11px] text-un1t-muted">{hoursMinutesLabel(row.totals.elsewhere_minutes)} other studio</div>
        )}
        {row.totals.untimed > 0 && <div className="text-[11px] text-un1t-muted">{untimedLabel(row.totals.untimed)}</div>}
      </td>
      <td data-testid="grid-contract" className={`${CELL} text-right tabular-nums whitespace-nowrap text-un1t-text`}>
        {row.contractMinutes !== null ? hoursMinutesLabel(row.contractMinutes) : <span className="text-un1t-muted">—</span>}
      </td>
      <td data-testid="grid-balance" title={balance.title || undefined} className={`${CELL} text-right tabular-nums whitespace-nowrap border-r`}>
        <span aria-hidden="true" className={TONE[balance.tone] || TONE.none}>{balance.text}</span>
        <span className="sr-only">{balance.srText}</span>
      </td>
      {row.cells.map((cell) => (
        <GridCell
          key={cell.date}
          cell={cell}
          onOpenBlock={onOpenBlock}
          canOpenBlock={canOpenBlock}
          selectMode={selectMode}
          selected={selected}
        />
      ))}
    </tr>
  )
}

function GridCell({ cell, onOpenBlock, canOpenBlock, selectMode, selected }) {
  return (
    <td className={`${CELL} min-w-[7.5rem]`}>
      <div className="flex flex-col gap-1">
        {cell.leave && (
          <div data-testid="grid-leave" title={cell.leave.title} className="flex items-center gap-1 rounded px-1.5 py-0.5 bg-sky-500/10 text-sky-700">
            <CalendarOff size={11} className="shrink-0" aria-hidden="true" />{cell.leave.label}
          </div>
        )}
        {cell.unavailable && (
          // The Days view's unavailability look (AVAIL.1b): dashed and
          // hatched, never a slate fill, because slate-500/10 is an ADMIN
          // SHIFT's surface (SHIFTTYPE.1) and an absence must not read as a shift.
          <div
            data-testid="grid-unavailable"
            title={cell.unavailable.title}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 border border-dashed border-zinc-500 bg-[repeating-linear-gradient(135deg,transparent_0_5px,rgb(113_113_122/0.12)_5px_10px)] text-zinc-800"
          >
            <CalendarX size={11} className="shrink-0" aria-hidden="true" />{cell.unavailable.text}
          </div>
        )}
        {cell.here.map((chip) => {
          const isSelected = selected.has(chip.block_id)
          const flag = chip.onLeave ? 'On leave' : chip.unavailable ? 'Unavailable' : null
          return (
            <button
              key={chip.key}
              type="button"
              data-testid="grid-shift"
              data-kind={chip.kind}
              disabled={!chip.block_id || !canOpenBlock(chip.block_id)}
              aria-pressed={selectMode ? isSelected : undefined}
              onClick={() => onOpenBlock?.(chip.block_id)}
              title={`${chip.name}, ${chip.time}${flag ? ` (${flag.toLowerCase()})` : ''}`}
              className={`w-full rounded border px-1.5 py-1 text-left transition-colors hover:border-un1t-text/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent disabled:opacity-60 ${
                chip.kind === 'admin' ? 'bg-slate-500/10 border-slate-500/30' : 'bg-un1t-surface border-un1t-border'
              } ${flag ? 'ring-1 ring-amber-500/60' : ''} ${selectMode && isSelected ? 'ring-2 ring-un1t-accent' : ''}`}
            >
              <span className="block whitespace-nowrap font-medium text-un1t-text">{chip.time}</span>
              <span className="block truncate text-un1t-subtle">{chip.kind === 'admin' ? 'Admin · ' : ''}{chip.name}</span>
              {flag && <span className="block text-[10px] text-amber-700">{flag}</span>}
            </button>
          )
        })}
        {cell.elsewhere.map((chip) => (
          <div
            key={chip.key}
            data-testid="grid-elsewhere"
            title={`${chip.location_name || 'Another studio'}: ${chip.name}, ${chip.time}`}
            className="rounded border border-dashed border-un1t-border px-1.5 py-1 text-un1t-muted"
          >
            <span className="sr-only">At another studio: </span>
            <span className="block whitespace-nowrap">{chip.time}</span>
            <span className="block truncate">{chip.location_name || 'Another studio'}</span>
          </div>
        ))}
      </div>
    </td>
  )
}
