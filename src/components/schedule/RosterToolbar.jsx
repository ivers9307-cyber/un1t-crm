// src/components/schedule/RosterToolbar.jsx
'use client'

// ROSTERLOOK.1 — the roster's ONE toolbar row.
//
// Was: an H2 + subtitle, EIGHT buttons wrapping onto two rows, then a separate
// week navigator with the publish chip under it: about 200px before the first
// banner. Now: [prev  period  next  Today  chip]   [My|All  Week|Month  More  Publish].
//
// Everything is still here and still gated as before; rosterToolbarModel
// (src/lib/roster-card-model.js) is where the gating is written down and
// tested. This component lays the model out and calls the handlers it is given.
// It owns NO roster state.
//
// The publish-state chip is a SLOT (`statusChip`). Its JSX stays in
// ScheduleCalendar.jsx because CHANGELOG.1 opens its "changes since publish"
// drawer from it; this row only gives it a stable place to sit.
//
// WRAPPING (CAL-UI-LOW.1 still applies): the row and both groups are
// flex-wrap, every control is whitespace-nowrap so a wrap falls BETWEEN
// controls, and Publish is the last child so on a phone it drops to its own
// line instead of leaving the screen. Toggle icons hide below `sm` to let both
// toggles and More share one 358px line. None of that is provable in jsdom.

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Send, Users, User, CalendarDays, CalendarRange, CalendarOff, Check, Copy, Settings } from 'lucide-react'
import MoreMenu from './MoreMenu'

const MORE_ICONS = { 'time-off': CalendarOff, select: Check, 'copy-week': Copy, 'copy-month': Copy, templates: Settings }

const NAV_BTN =
  'p-2 rounded-lg hover:bg-un1t-border/50 text-un1t-subtle hover:text-un1t-text transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent'
const SEGMENTED = 'flex shrink-0 bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden text-xs'
const segment = (on) =>
  `flex items-center gap-1.5 px-3 py-2 whitespace-nowrap transition-colors ${
    on ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
  }`

export default function RosterToolbar({
  viewType, periodLabel, onPrev, onNext, onToday, statusChip,
  viewMode, onViewMode, onViewType,
  model, onSelectToggle, onCopyWeek, onCopyMonth, onPublish, publishing,
}) {
  const period = viewType === 'month' ? 'month' : 'week'
  // Menu key → the handler ScheduleCalendar has always had for that action.
  const HANDLERS = { select: onSelectToggle, 'copy-week': onCopyWeek, 'copy-month': onCopyMonth }

  return (
    <div data-testid="schedule-toolbar" className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div data-testid="schedule-toolbar-nav" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5">
        <button type="button" onClick={onPrev} aria-label={`Previous ${period}`} className={NAV_BTN}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <span className="px-1 text-sm sm:text-base font-semibold text-un1t-text whitespace-nowrap">{periodLabel}</span>
        <button type="button" onClick={onNext} aria-label={`Next ${period}`} className={NAV_BTN}>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onToday}
          className="ml-1 text-xs px-2 py-1 rounded-md text-blue-700 hover:text-blue-800 hover:bg-un1t-border/40 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
        >
          Today
        </button>
        {statusChip && <span className="ml-1 inline-flex">{statusChip}</span>}
      </div>

      <div data-testid="schedule-toolbar-actions" className="relative flex flex-wrap items-center gap-2">
        <div className={SEGMENTED}>
          <button type="button" aria-pressed={viewMode === 'my'} onClick={() => onViewMode('my')} className={segment(viewMode === 'my')}>
            <User size={14} className="hidden sm:inline" aria-hidden="true" /> My shifts
          </button>
          <button type="button" aria-pressed={viewMode === 'all'} onClick={() => onViewMode('all')} className={segment(viewMode === 'all')}>
            <Users size={14} className="hidden sm:inline" aria-hidden="true" /> All staff
          </button>
        </div>

        <div className={SEGMENTED}>
          <button type="button" aria-pressed={viewType === 'week'} onClick={() => onViewType('week')} className={segment(viewType === 'week')}>
            <CalendarDays size={14} className="hidden sm:inline" aria-hidden="true" /> Week
          </button>
          <button type="button" aria-pressed={viewType === 'month'} onClick={() => onViewType('month')} className={segment(viewType === 'month')}>
            <CalendarRange size={14} className="hidden sm:inline" aria-hidden="true" /> Month
          </button>
        </div>

        {model.timeOffInline && (
          <Link
            href="/schedule/time-off"
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-border text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/30 transition-colors whitespace-nowrap"
          >
            <CalendarOff size={14} aria-hidden="true" /> Time off
          </Link>
        )}

        {model.moreItems.length > 0 && (
          <MoreMenu
            items={model.moreItems}
            icons={MORE_ICONS}
            label={model.moreLabel}
            active={model.moreActive}
            onSelect={(key) => HANDLERS[key]?.()}
          />
        )}

        {model.showPublish && (
          <button
            type="button"
            onClick={onPublish}
            disabled={publishing}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            <Send size={14} aria-hidden="true" /> {publishing ? 'Publishing...' : 'Publish'}
          </button>
        )}
      </div>
    </div>
  )
}
