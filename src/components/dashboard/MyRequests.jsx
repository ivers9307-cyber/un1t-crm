'use client'
// My requests — live list of the coach's own posted swap + time-off
// requests with inline Cancel actions. Replaces the two read-only
// ListCards ("Swap requests for you" + "Your time-off requests") that
// previously deep-linked to /schedule.
//
// Props (initial server data, refreshed via router.refresh() after mutations):
//   postedSwaps  — swaps the user posted that are still live (myPostedSwaps:
//                  pending OR awaiting_approval once a colleague claims it)
//   timeOff      — user's own pending time-off rows (myPendingTimeOff)
//
// Swaps OFFERED to this coach (accept/decline/claim) are handled by the
// sibling <SwapActions> component (CT-P3b) — not here.
//
// Cancel calls:
//   Swap   → PUT /api/schedule/swaps/[id]    { status: 'cancelled' }
//   Time-off → PUT /api/schedule/time-off/[id] { status: 'cancelled' }

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight, Calendar } from 'lucide-react'
import { SectionHeader, ListCard } from '@/components/dashboard/Cards'
import Button from '@/components/ui/Button'

// ── status chips ──────────────────────────────────────────────────────────
function StatusChip({ status }) {
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700">
        Approved
      </span>
    )
  }
  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700">
        Rejected
      </span>
    )
  }
  // awaiting_manager / awaiting_approval are amber (the backend uses
  // 'awaiting_approval'; the older 'awaiting_manager' string is kept for
  // back-compat). Default (pending) is neutral slate.
  if (status === 'awaiting_manager' || status === 'awaiting_approval') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700">
        Awaiting manager
      </span>
    )
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700">
      Pending
    </span>
  )
}

// ── single row ────────────────────────────────────────────────────────────
function RequestRow({ icon, title, subtitle, status, onCancel, cancelling, isLast }) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 ${
        !isLast ? 'border-b border-un1t-border' : ''
      }`}
    >
      {icon ? (
        <span className="text-un1t-subtle flex-shrink-0">{icon}</span>
      ) : null}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-un1t-text truncate">{title}</div>
        {subtitle ? (
          <div className="text-xs text-un1t-subtle truncate">{subtitle}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <StatusChip status={status} />
        {onCancel ? (
          <Button
            variant="ghost"
            size="sm"
            loading={cancelling}
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────
export default function MyRequests({ postedSwaps = [], timeOff = [] }) {
  const router = useRouter()
  // Track which row ids are mid-cancel-request to disable the button.
  const [cancellingSwap, setCancellingSwap] = useState(null)
  const [cancellingTimeOff, setCancellingTimeOff] = useState(null)

  const totalCount = postedSwaps.length + timeOff.length
  const isEmpty = totalCount === 0

  async function handleCancelSwap(id) {
    if (cancellingSwap) return
    setCancellingSwap(id)
    try {
      const res = await fetch(`/api/schedule/swaps/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        console.error('[MyRequests] cancel swap failed:', json.error || res.status)
      } else {
        router.refresh()
      }
    } catch (e) {
      console.error('[MyRequests] cancel swap error:', e?.message || e)
    } finally {
      setCancellingSwap(null)
    }
  }

  async function handleCancelTimeOff(id) {
    if (cancellingTimeOff) return
    setCancellingTimeOff(id)
    try {
      const res = await fetch(`/api/schedule/time-off/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        console.error('[MyRequests] cancel time-off failed:', json.error || res.status)
      } else {
        router.refresh()
      }
    } catch (e) {
      console.error('[MyRequests] cancel time-off error:', e?.message || e)
    } finally {
      setCancellingTimeOff(null)
    }
  }

  // Build the flat row list in order: posted swaps → swaps for me → time-off
  const rows = []

  for (const s of postedSwaps) {
    const shiftName =
      s.requester_shift?.shift_templates?.name ||
      s.requester_shift?.shift_blocks?.shift_templates?.name ||
      'Shift'
    const shiftDate =
      s.requester_shift?.shift_blocks?.block_date ||
      s.requester_shift?.shift_date ||
      null
    rows.push({
      key: `swap-posted-${s.id}`,
      icon: <ArrowLeftRight size={16} />,
      title: `Swap request — ${shiftName}`,
      subtitle: shiftDate
        ? `Posted for ${shiftDate}`
        : `Posted ${new Date(s.created_at).toLocaleDateString()}`,
      // Render the real status so an awaiting_approval posted swap (a
      // colleague has claimed it) shows the amber chip. The requester can
      // still cancel a claimed swap — the backend allows it.
      status: s.status || 'pending',
      onCancel: () => handleCancelSwap(s.id),
      cancelling: cancellingSwap === s.id,
    })
  }

  for (const t of timeOff) {
    const dateLabel =
      t.start_date === t.end_date
        ? t.start_date
        : `${t.start_date} – ${t.end_date}`
    const isPending = !t.status || t.status === 'pending'
    rows.push({
      key: `timeoff-${t.id}`,
      icon: <Calendar size={16} />,
      title: `${t.type || 'Time off'} request`,
      subtitle: dateLabel,
      status: t.status || 'pending',
      onCancel: isPending ? () => handleCancelTimeOff(t.id) : null,
      cancelling: cancellingTimeOff === t.id,
    })
  }

  return (
    <div className="max-w-5xl">
      <SectionHeader title="My requests" count={isEmpty ? null : totalCount} />
      <ListCard empty={isEmpty} emptyText="No open requests.">
        {rows.map((row, i) => (
          <RequestRow
            key={row.key}
            icon={row.icon}
            title={row.title}
            subtitle={row.subtitle}
            status={row.status}
            onCancel={row.onCancel}
            cancelling={row.cancelling}
            isLast={i === rows.length - 1}
          />
        ))}
      </ListCard>
    </div>
  )
}
