'use client'

// StudioOverviewDialog — the per-day demand-vs-supply breakdown (mig 125),
// opened from a day header in the roster calendar.
//
// ROSTERLOOK.1 — this file was StudioOverviewStrip: a row of seven day tiles
// ABOVE the calendar, each opening this dialog. The tiles are gone (their
// status moved into the calendar's own day headers, see schedule/DayHeader);
// the dialog, its data and its focus handling are what they were. It is
// CONTROLLED now: the parent says which day is open (`openDate`) because the
// thing that opens it lives in a sibling component.
//
// It still fetches /api/schedule/overview whenever the calendar's WEEK range or
// `dataVersion` changes, open or not, so a click on a header opens onto data
// that is already there. In month view the parent passes no range and nothing
// is fetched: the strip drew 42 tiles there, the dialog cannot be opened there.
//
// Almost all of it is informational (edit events at /events, booking types at
// /bookings/event-types). The ONE exception is the undermanned-shift rows:
// since CAL-UI-LOW.2 each opens that shift in the calendar, via `onOpenShift`.

import { useState, useEffect } from 'react'
import { Calendar, AlertCircle, Loader2, Flag, Palmtree, Users, Clock, UserX } from 'lucide-react'
import { Modal } from '@/components/ui'

const STATUS_STYLES = {
  red:   { border: 'border-red-500/60',    bg: 'bg-red-500/5',    label: 'Uncovered' },
  amber: { border: 'border-amber-500/60',  bg: 'bg-amber-500/5',  label: 'Undermanned' },
  green: { border: 'border-emerald-500/30', bg: 'bg-un1t-surface',   label: 'OK' },
}

const KIND_LABELS = {
  race:        'Race',
  workshop:    'Workshop',
  seminar:     'Seminar',
  open_day:    'Open day',
  masterclass: 'Masterclass',
}

// Strip seconds off "HH:MM:SS" → "HH:MM". Handles null defensively.
function fmtTime(t) {
  if (!t) return null
  return String(t).slice(0, 5)
}

// OVERVIEW-REFRESH.1 — `dataVersion` is a monotonic counter the parent
// (ScheduleRosterView) bumps every time ScheduleCalendar reports a successful
// mutation (assign / unassign / create / delete / bulk-assign / publish
// / copy-week / partial save). Including it in the useEffect deps
// causes this dialog to re-fetch in lockstep with the calendar, so
// operators no longer need to hard-refresh to see updated coverage
// numbers or under-min flags.
// CAL-UI-LOW.2 — `onOpenShift(date, blockId)` is how a row in the day
// dialog reaches the shift it names. The dialog itself owns no roster
// state, so it hands the request to its parent (ScheduleRosterView),
// which routes it to the calendar: the calendar navigates to the
// date and opens the SAME block-detail dialog a click on the card
// opens. Before this the dialog named an undermanned shift and left
// the operator to find it by eye.
// ROSTERLOOK.1 — `restoreFocusRef` points at the day header that opened the
// dialog. The Modal returns focus to document.activeElement-at-open, and
// Safari does not focus a button on click, so there the opener has to be
// handed over rather than inferred.
export default function StudioOverviewDialog({ range, locationId, dataVersion = 0, openDate, onClose, onOpenShift, restoreFocusRef }) {
  // `loaded` remembers WHICH range the data answers for. A refetch of the same
  // range (a dataVersion bump) keeps the previous data on screen, as the strip
  // did; data for a DIFFERENT range is not this range's data, and showing it
  // would tell the operator "No overview for this day" about a day that is
  // simply still loading.
  const [loaded, setLoaded] = useState(null) // { key, data }
  const [error, setError] = useState(null)
  const rangeKey = range?.from && range?.to && locationId ? `${range.from}|${range.to}|${locationId}` : null
  const data = loaded && loaded.key === rangeKey ? loaded.data : null

  useEffect(() => {
    // No range = nothing can open this dialog (the parent passes none in month
    // view, where there are no day headers), so there is nothing to fetch.
    if (!rangeKey) return
    let cancelled = false
    setError(null)
    const url = `/api/schedule/overview?from=${range.from}&to=${range.to}&location_id=${locationId}`
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j.success) {
          setError(j.error || 'Failed to load overview')
          setLoaded(null)
        } else {
          setLoaded({ key: rangeKey, data: j.data })
        }
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Network error') })
    return () => { cancelled = true }
  }, [rangeKey, range?.from, range?.to, locationId, dataVersion])

  if (!openDate) return null

  const day = (data?.days || []).find((d) => d.date === openDate) || null
  const longDate = new Date(openDate + 'T00:00:00').toLocaleDateString('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  // The three states the strip used to show ABOVE the calendar (failed,
  // loading, no such day) render INSIDE the dialog now: there is no strip left
  // to hold them. `!data` is the loading state; a refetch keeps the previous
  // data on screen exactly as the strip did.
  return (
    <Modal open onClose={onClose} title={longDate} size="md" restoreFocusRef={restoreFocusRef}>
      {error ? (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle size={12} aria-hidden="true" /> Overview: {error}
        </div>
      ) : !data ? (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Loading overview…
        </div>
      ) : !day ? (
        <Muted>No overview for this day.</Muted>
      ) : (
        <DayDetailBody
          day={day}
          onOpenShift={onOpenShift && ((blockId) => {
            // Close the summary first: the operator asked for the shift, and
            // leaving this dialog stacked over the calendar's own block dialog
            // would bury the thing they came for.
            onClose()
            onOpenShift(day.date, blockId)
          })}
        />
      )}
    </Modal>
  )
}

// Day-detail dialog. Summary of the day; the undermanned-shift rows are
// the one actionable part — each opens that shift in the calendar below.
// Everything else is read-only (edit events at /events, booking types at
// /bookings/event-types).
//
// CAL-UI-LOW.2 — built on the Modal primitive rather than a bespoke
// fixed overlay, so it inherits the dialog contract: focus moves into
// the panel on open, Tab is trapped inside it, Escape and the backdrop
// close it, and focus returns to the day header that opened it.
function DayDetailBody({ day, onOpenShift }) {
  const status = STATUS_STYLES[day.classification] || STATUS_STYLES.green
  const supply = Math.max(0, day.staff_scheduled - day.staff_on_leave)

  return (
      <div>
        {/* Demand-vs-supply summary headline */}
        <div className={`px-3 py-2 rounded-md border ${status.border} ${status.bg}`}>
          <div className="flex items-center justify-between text-xs">
            <span className={`uppercase tracking-wider font-semibold ${
              day.classification === 'red' ? 'text-red-700' :
              day.classification === 'amber' ? 'text-amber-700' :
              'text-emerald-700'
            }`}>
              {status.label}
            </span>
            <span className="font-mono tabular-nums text-un1t-text">
              Supply {supply} / Demand {day.demand}
            </span>
          </div>
        </div>

        {/* SHIFTMIN.1 — undermanned shifts callout. Only renders
            when at least one block is below its min_coaches floor.
            Above events so it's the first thing the operator sees
            when the day is flagged. */}
        {(day.under_min_blocks?.length || 0) > 0 && (
          <DetailSection icon={UserX} title="Undermanned shifts">
            <ul className="space-y-1.5">
              {day.under_min_blocks.map((b) => (
                <li key={b.id}>
                  <UnderMinRow block={b} onOpen={onOpenShift && (() => onOpenShift(b.id))} />
                </li>
              ))}
            </ul>
          </DetailSection>
        )}

        {/* Events section */}
        <DetailSection icon={Flag} title="Events">
          {day.events.length === 0 ? (
            <Muted>No events scheduled.</Muted>
          ) : (
            <ul className="space-y-1.5">
              {day.events.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="text-un1t-text truncate">{e.name}</div>
                    <div className="text-[10px] text-un1t-muted uppercase tracking-wider">
                      {KIND_LABELS[e.kind] || e.kind}
                      {e.start_time && (
                        <span className="ml-1.5 text-un1t-subtle normal-case tracking-normal">
                          @ {fmtTime(e.start_time)}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-un1t-subtle tabular-nums shrink-0">
                    needs {e.staff_required}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        {/* Bookable Calendly types section */}
        <DetailSection icon={Calendar} title="Bookable today">
          {day.event_types.length === 0 ? (
            <Muted>No booking types open today.</Muted>
          ) : (
            <ul className="space-y-1.5">
              {day.event_types.map((et) => (
                <li key={et.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="text-un1t-text truncate">{et.name}</div>
                    <div className="text-[10px] text-un1t-muted">
                      {fmtTime(et.window_start) && fmtTime(et.window_end) ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock size={9} />
                          {fmtTime(et.window_start)}–{fmtTime(et.window_end)}
                        </span>
                      ) : 'window unknown'}
                    </div>
                  </div>
                  <span className="text-xs text-un1t-subtle tabular-nums shrink-0">
                    {et.staff_required === 0 ? 'no own demand' : `needs ${et.staff_required}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        {/* Staffing section */}
        <DetailSection icon={Users} title="Staffing">
          <div className="text-sm text-un1t-text">
            <span className="tabular-nums font-semibold">{day.staff_scheduled}</span>
            <span className="text-un1t-subtle"> scheduled</span>
            {day.staff_on_leave > 0 && (
              <>
                <span className="text-un1t-subtle">, </span>
                <span className="tabular-nums font-semibold text-amber-700">{day.staff_on_leave}</span>
                <span className="text-un1t-subtle"> on leave</span>
              </>
            )}
          </div>
          {day.time_off.length > 0 && (
            <div className="mt-1.5">
              <div className="text-[10px] uppercase tracking-wider text-un1t-muted mb-1 inline-flex items-center gap-1">
                <Palmtree size={10} /> On leave
              </div>
              <ul className="text-xs text-un1t-subtle space-y-0.5">
                {day.time_off.map((name, i) => (
                  <li key={`${name}-${i}`}>{name}</li>
                ))}
              </ul>
            </div>
          )}
        </DetailSection>

        <div className="mt-4 pt-3 border-t border-un1t-border text-[11px] text-un1t-muted">
          Edit events at <code>/events</code>, booking types at <code>/bookings/event-types</code>, shifts inside the calendar below.
        </div>
      </div>
  )
}

// One undermanned shift. A row is a real <button> when the dialog has been
// given somewhere to send the request (the calendar below), and plain text
// when it has not — a control that looks clickable and does nothing is worse
// than one that never offered.
function UnderMinRow({ block, onOpen }) {
  const body = (
    <>
      <div className="min-w-0">
        <div className="text-un1t-text truncate">{block.label}</div>
        <div className="text-[10px] text-un1t-muted">
          <span className="inline-flex items-center gap-1">
            <Clock size={9} aria-hidden="true" /> {block.time}
          </span>
        </div>
      </div>
      <span className="text-xs text-amber-700 tabular-nums shrink-0">
        {block.assigned} of {block.min} assigned
      </span>
    </>
  )
  if (!onOpen) {
    return <div className="flex items-baseline justify-between gap-3 text-sm">{body}</div>
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="under-min-shift"
      className="w-[calc(100%+1rem)] -mx-2 px-2 py-1 rounded-md flex items-baseline justify-between gap-3 text-sm text-left hover:bg-un1t-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
    >
      <span className="sr-only">Open shift: </span>
      {body}
    </button>
  )
}

function DetailSection({ icon: Icon, title, children }) {
  return (
    <section className="py-4 border-t border-un1t-border first:border-t-0">
      <h4 className="text-[10px] uppercase tracking-wider text-un1t-subtle font-semibold mb-2 inline-flex items-center gap-1.5">
        <Icon size={11} /> {title}
      </h4>
      {children}
    </section>
  )
}

function Muted({ children }) {
  return <p className="text-xs text-un1t-muted italic">{children}</p>
}
