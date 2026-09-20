'use client'

// ROSTERVIS.1 / CHANGELOG.1 — the schedule header's publication chip, in its
// own file so the header can be rearranged without rewriting it. The calendar
// owns the state (which period is published, whether the change-log drawer is
// open); this only draws the chip and reports a click.

import { Clock, CalendarOff, AlertTriangle, Check } from 'lucide-react'
import { PUBLICATION_LABELS } from '@/lib/roster-staffing'

// ROSTERVIS.1 — the header chip's look per publication status. Text + icon
// carry the meaning; colour is the at-a-glance cue (house chip rule: -500/10
// background, -700 text).
const PUBLICATION_CHIP = {
  published: { cls: 'bg-green-500/10 text-green-700 border-green-500/30', Icon: Check },
  pending: { cls: 'bg-blue-500/10 text-blue-700 border-blue-500/30', Icon: Clock },
  partial: { cls: 'bg-amber-500/10 text-amber-700 border-amber-500/30', Icon: AlertTriangle },
  unpublished: { cls: 'bg-slate-500/10 text-slate-700 border-slate-500/30', Icon: CalendarOff },
}

/**
 * @param {object} props
 * @param {{status:string, draftPending?:boolean, publishedCount?:number, blockCount?:number}|null} props.publication
 *   null (or status 'none') = nothing to say right now: loading, or a period
 *   with no shifts. The live region stays; only its contents go.
 * @param {'week'|'month'} props.viewType
 * @param {()=>void} props.onOpenChangeLog
 * @param {React.RefObject<HTMLButtonElement>} [props.triggerRef]  set on the
 *   button, so the drawer can hand focus back to it on close.
 */
export default function PublicationStatusChip({ publication, viewType, onOpenChangeLog, triggerRef }) {
  // The role=status wrapper is ALWAYS mounted. A live region that is inserted
  // already populated is often skipped by screen readers; one that is already
  // there and then changes is announced. It used to unmount on every load.
  // React leaves the DOM alone when a re-render produces the same text, so a
  // plain re-render announces nothing.
  const chip = publication ? PUBLICATION_CHIP[publication.status] : null
  if (!chip) return <div className="flex justify-center" role="status" />
  const Icon = chip.Icon
  const periodWord = viewType === 'month' ? 'Month' : 'Week'
  const label = PUBLICATION_LABELS[publication.status]
  const extra = publication.status === 'published' && publication.draftPending
    ? ', changes awaiting approval'
    : publication.status === 'partial'
      ? ` (${publication.publishedCount} of ${publication.blockCount} shifts)`
      : ''
  // CHANGELOG.1 — a published (or partly published) period can have
  // post-publish edits, so its chip opens the change log. The TEXT is
  // identical either way; only the element differs. The live region
  // sits on the wrapper so the button carries no conflicting role.
  const canOpenLog = publication.status === 'published' || publication.status === 'partial'
  const chipCls = `inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${chip.cls}`
  const chipBody = (
    <>
      <Icon size={12} aria-hidden="true" />
      <span className="sr-only">{periodWord} status: </span>
      {label}{extra}
    </>
  )
  return (
    <div className="mt-1.5 flex justify-center" role="status">
      {canOpenLog ? (
        <button
          ref={triggerRef}
          type="button"
          data-testid="publication-status"
          // The content alone names it "Week status: Published", which says
          // nothing about what pressing it does, and a title never reaches a
          // touch user. The visible text is unchanged.
          aria-label={`${label}${extra}. View changes since publish`}
          aria-haspopup="dialog"
          title="See changes since publish"
          onClick={onOpenChangeLog}
          className={`${chipCls} cursor-pointer hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600`}
        >
          {chipBody}
        </button>
      ) : (
        <span data-testid="publication-status" className={chipCls}>
          {chipBody}
        </span>
      )}
    </div>
  )
}
