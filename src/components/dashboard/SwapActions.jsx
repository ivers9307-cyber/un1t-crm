'use client'
// SwapActions — coach self-service swap surfaces on /dashboard/today (CT-P3b).
//
// Three independently-fetched sections, all mounted above MyRequests:
//   1. "Swaps offered to you"  (GET ?for_me=1) — Accept / Decline a pending
//      targeted swap; Withdraw + "Awaiting manager" once it's awaiting_approval.
//   2. "Open swaps you can take" (GET ?open=1)  — Claim an unclaimed pool swap.
//   3. "On with you today" (GET /api/schedule/shifts for today) — read-only
//      list of the other coaches working today.
//
// Each section renders nothing when its list is empty (no empty-state noise),
// but the component itself is always mounted. After any successful PUT we
// refetch the swap lists AND call router.refresh() so MyRequests / MonthRoster
// re-pull their server data. Errors are inline + non-blocking (mirrors
// MyRequests' console.error + a small inline message).
//
// Lifecycle PUT contract (handled by the resolver behind the route):
//   accept / claim → { status: 'awaiting_approval' }
//   decline        → { status: 'rejected' }
//   withdraw       → { status: 'pending' }

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftRight, Inbox, Users } from 'lucide-react'
import { SectionHeader, ListCard } from '@/components/dashboard/Cards'
import Button from '@/components/ui/Button'
import { groupTeamShiftsByCoach, coachSpanLabel } from '@shared/team-today'

// ── helpers ──────────────────────────────────────────────────────────────
function shiftNameOf(row, fallback = 'a shift') {
  return row?.requester_shift?.shift_templates?.name || fallback
}

function shiftDateOf(row) {
  return row?.requester_shift?.shift_date || null
}

function AwaitingChip() {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700">
      Awaiting manager
    </span>
  )
}

// ── one offered/open row ───────────────────────────────────────────────────
function ActionRow({ icon, title, subtitle, chip, actions, isLast }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${!isLast ? 'border-b border-un1t-border' : ''}`}>
      {icon ? <span className="text-un1t-subtle flex-shrink-0">{icon}</span> : null}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-un1t-text truncate">{title}</div>
        {subtitle ? <div className="text-xs text-un1t-subtle truncate">{subtitle}</div> : null}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {chip}
        {actions}
      </div>
    </div>
  )
}

// ── main component ─────────────────────────────────────────────────────────
export default function SwapActions({ locationId, todayIso, currentProfileId }) {
  const router = useRouter()
  const [offered, setOffered] = useState([])
  const [openPool, setOpenPool] = useState([])
  const [onToday, setOnToday] = useState([])
  const [busyId, setBusyId] = useState(null)   // swap id currently mutating (+ verb)
  const [error, setError] = useState(null)

  const loadSwaps = useCallback(async () => {
    if (!locationId) return
    try {
      const qs = `location_id=${encodeURIComponent(locationId)}`
      const [forMeRes, openRes] = await Promise.all([
        fetch(`/api/schedule/swaps?${qs}&for_me=1`),
        fetch(`/api/schedule/swaps?${qs}&open=1`),
      ])
      const forMeJson = await forMeRes.json().catch(() => ({}))
      const openJson = await openRes.json().catch(() => ({}))
      setOffered(forMeRes.ok && forMeJson.success ? (forMeJson.data || []) : [])
      setOpenPool(openRes.ok && openJson.success ? (openJson.data || []) : [])
    } catch (e) {
      console.error('[SwapActions] load swaps error:', e?.message || e)
    }
  }, [locationId])

  const loadOnToday = useCallback(async () => {
    if (!locationId || !todayIso) return
    try {
      const qs = `location_id=${encodeURIComponent(locationId)}&start_date=${todayIso}&end_date=${todayIso}`
      const res = await fetch(`/api/schedule/shifts?${qs}`)
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.success) {
        const others = (json.data || []).filter((s) => s.profile_id && s.profile_id !== currentProfileId)
        setOnToday(others)
      } else {
        setOnToday([])
      }
    } catch (e) {
      console.error('[SwapActions] load on-today error:', e?.message || e)
    }
  }, [locationId, todayIso, currentProfileId])

  useEffect(() => {
    loadSwaps()
    loadOnToday()
  }, [loadSwaps, loadOnToday])

  // Drive a swap through the lifecycle, then refetch + refresh server data.
  async function mutate(id, status, verb) {
    if (busyId) return
    setBusyId(`${id}:${verb}`)
    setError(null)
    try {
      const res = await fetch(`/api/schedule/swaps/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        const msg = json.error || `Could not ${verb} (${res.status}).`
        console.error(`[SwapActions] ${verb} failed:`, msg)
        setError(msg)
      } else {
        await loadSwaps()
        router.refresh()
      }
    } catch (e) {
      console.error(`[SwapActions] ${verb} error:`, e?.message || e)
      setError('Network error. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  // Group today's team shifts by coach — one row per person (not per shift).
  const onTodayCoaches = groupTeamShiftsByCoach(onToday)
  const hasNothing = offered.length === 0 && openPool.length === 0 && onTodayCoaches.length === 0
  if (hasNothing) return null

  return (
    <div className="max-w-5xl">
      {error && (
        <div className="mt-3 rounded-lg bg-red-500/10 text-red-700 text-sm px-3 py-2">{error}</div>
      )}

      {/* 1 — Swaps offered to you */}
      {offered.length > 0 && (
        <>
          <SectionHeader title="Swaps offered to you" count={offered.length} />
          <ListCard>
            {offered.map((row, i) => {
              const name = row.requester?.full_name || 'A colleague'
              const shiftName = shiftNameOf(row, 'a shift')
              const date = shiftDateOf(row)
              const isLast = i === offered.length - 1
              if (row.status === 'awaiting_approval') {
                return (
                  <ActionRow
                    key={row.id}
                    icon={<ArrowLeftRight size={16} />}
                    title={`${name} wants you to take ${shiftName}`}
                    subtitle={date || undefined}
                    chip={<AwaitingChip />}
                    isLast={isLast}
                    actions={
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === `${row.id}:withdraw`}
                        onClick={() => mutate(row.id, 'pending', 'withdraw')}
                      >
                        Withdraw
                      </Button>
                    }
                  />
                )
              }
              return (
                <ActionRow
                  key={row.id}
                  icon={<ArrowLeftRight size={16} />}
                  title={`${name} wants you to take ${shiftName}`}
                  subtitle={date || undefined}
                  isLast={isLast}
                  actions={
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busyId === `${row.id}:accept`}
                        onClick={() => mutate(row.id, 'awaiting_approval', 'accept')}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === `${row.id}:decline`}
                        onClick={() => mutate(row.id, 'rejected', 'decline')}
                      >
                        Decline
                      </Button>
                    </>
                  }
                />
              )
            })}
          </ListCard>
        </>
      )}

      {/* 2 — Open swaps you can take */}
      {openPool.length > 0 && (
        <>
          <SectionHeader title="Open swaps you can take" count={openPool.length} />
          <ListCard>
            {openPool.map((row, i) => {
              const name = row.requester?.full_name || 'A colleague'
              const shiftName = shiftNameOf(row, 'Shift')
              const date = shiftDateOf(row)
              return (
                <ActionRow
                  key={row.id}
                  icon={<Inbox size={16} />}
                  title={`${name} · ${shiftName}`}
                  subtitle={date || undefined}
                  isLast={i === openPool.length - 1}
                  actions={
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busyId === `${row.id}:claim`}
                      onClick={() => mutate(row.id, 'awaiting_approval', 'claim')}
                    >
                      Claim
                    </Button>
                  }
                />
              )
            })}
          </ListCard>
        </>
      )}

      {/* 3 — On with you today (read-only). Grouped by coach: one row per
          person with their earliest–latest span + shift count, so a coach
          with several blocks shows once and the count reflects people on
          today, not shift rows. */}
      {onTodayCoaches.length > 0 && (
        <>
          <SectionHeader title="On with you today" count={onTodayCoaches.length} />
          <ListCard>
            {onTodayCoaches.map((c, i) => (
              <ActionRow
                key={c.profileId}
                icon={<Users size={16} />}
                title={c.name}
                subtitle={coachSpanLabel(c) || undefined}
                chip={
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600">
                    {c.count} shift{c.count === 1 ? '' : 's'}
                  </span>
                }
                isLast={i === onTodayCoaches.length - 1}
              />
            ))}
          </ListCard>
        </>
      )}
    </div>
  )
}
