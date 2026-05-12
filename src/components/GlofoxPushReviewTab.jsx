'use client'

// GLOFOX3.6 — Review tab on /admin/glofox-import. Shows
// glofox_push_events rows where status ∈ {failed, needs_review}
// AND reviewed_at IS NULL. Per-row actions: retry, dismiss,
// jump-to-contact.
//
// Lazy-loads on mount so the parent page render isn't blocked.
// Master only at the page level (/admin/layout.js + the API).

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { AlertTriangle, AlertCircle, RefreshCw, Check, ExternalLink, Loader2 } from 'lucide-react'

const STATUS_META = {
  failed:       { Icon: AlertCircle,    cls: 'text-red-700 border-red-500/40 bg-red-500/10' },
  needs_review: { Icon: AlertTriangle,  cls: 'text-amber-700 border-amber-500/40 bg-amber-500/10' },
}

const SOURCE_LABEL = {
  booking_form:       'Booking form',
  event_registration: 'Event registration',
  manual_button:      'Manual button',
  dup_check:          'Dup-check (on contact create)',
  cron:               'Background cron',
}

function relativeTime(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const days = Math.floor(ms / 86_400_000)
  if (days < 1) {
    const hours = Math.floor(ms / 3_600_000)
    if (hours < 1) {
      const mins = Math.floor(ms / 60_000)
      return mins < 1 ? 'just now' : `${mins}m ago`
    }
    return `${hours}h ago`
  }
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30.44)
  return `${months}mo ago`
}

export default function GlofoxPushReviewTab() {
  const [events, setEvents] = useState(null) // null = loading
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [actionResult, setActionResult] = useState(null) // {eventId, kind, text}

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch('/api/admin/glofox-push-events?limit=100')
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Load failed (${r.status})`)
        setEvents([])
        return
      }
      setEvents(j.events || [])
    } catch (e) {
      setError(e?.message || 'Network error')
      setEvents([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function retry(ev) {
    setBusyId(ev.id)
    setActionResult(null)
    try {
      const r = await fetch(`/api/admin/glofox-push-events/${ev.id}/retry`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok && r.status >= 500) {
        setActionResult({ eventId: ev.id, kind: 'error', text: j.error || `Retry failed (${r.status})` })
      } else if (j.result?.status) {
        setActionResult({
          eventId: ev.id,
          kind: j.result.status === 'failed' ? 'error' : 'ok',
          text: `Retry → ${j.result.status}${j.result.error ? `: ${j.result.error}` : ''}`,
        })
      } else {
        setActionResult({ eventId: ev.id, kind: 'ok', text: 'Retry submitted.' })
      }
      await load() // refresh the list — the old row is now reviewed_at != null
    } catch (e) {
      setActionResult({ eventId: ev.id, kind: 'error', text: e?.message || 'Network error' })
    } finally {
      setBusyId(null)
    }
  }

  async function dismiss(ev) {
    setBusyId(ev.id)
    setActionResult(null)
    try {
      const r = await fetch(`/api/admin/glofox-push-events/${ev.id}/dismiss`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setActionResult({ eventId: ev.id, kind: 'error', text: j.error || `Dismiss failed (${r.status})` })
        return
      }
      setActionResult({ eventId: ev.id, kind: 'ok', text: 'Marked reviewed.' })
      await load()
    } catch (e) {
      setActionResult({ eventId: ev.id, kind: 'error', text: e?.message || 'Network error' })
    } finally {
      setBusyId(null)
    }
  }

  if (events === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-un1t-light py-8 justify-center">
        <Loader2 size={14} className="animate-spin" /> Loading push events…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
      </div>
    )
  }
  if (events.length === 0) {
    return (
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8 text-center text-sm text-un1t-light">
        <Check size={24} className="mx-auto text-emerald-400 mb-2" />
        <p className="text-un1t-white font-medium">All clear.</p>
        <p className="mt-1">No failed or needs-review pushes outstanding.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-un1t-light">
        Showing the {events.length} most recent push event{events.length === 1 ? '' : 's'} needing review.
        Retry re-runs the same push (search-and-link for dup-check rows, search-or-create-with-trial for the rest).
        Dismiss marks the row reviewed without retrying — use for cases you fixed in Glofox directly.
      </p>

      {events.map((ev) => {
        const meta = STATUS_META[ev.status] || STATUS_META.failed
        const Icon = meta.Icon
        const c = ev.contacts
        const contactLabel = c
          ? (c.name || c.email || `Contact ${ev.contact_id?.slice(0, 8)}`)
          : `Contact ${ev.contact_id?.slice(0, 8) || 'unknown'}`
        const isBusy = busyId === ev.id
        const myResult = actionResult?.eventId === ev.id ? actionResult : null

        return (
          <div
            key={ev.id}
            className={`rounded-lg border p-3 space-y-2 ${meta.cls}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <Icon size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-un1t-white truncate">
                    {contactLabel}
                    {c?.email && c.name && (
                      <span className="text-un1t-light font-normal ml-1.5">· {c.email}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-un1t-light mt-0.5">
                    <span className="uppercase tracking-wider">{ev.status.replace('_', ' ')}</span>
                    {' · '}
                    {SOURCE_LABEL[ev.source] || ev.source}
                    {' · '}
                    {relativeTime(ev.created_at)}
                  </div>
                  {ev.error_message && (
                    <p className="text-[11px] text-un1t-light mt-1 leading-snug whitespace-pre-wrap break-words">
                      {ev.error_message}
                    </p>
                  )}
                  {ev.glofox_member_id && (
                    <p className="text-[11px] text-un1t-mid mt-1 font-mono truncate">
                      Glofox ID: {ev.glofox_member_id}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                {ev.contact_id && (
                  <Link
                    href={`/contacts/${ev.contact_id}`}
                    className="text-[11px] text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                  >
                    Contact <ExternalLink size={10} />
                  </Link>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => retry(ev)}
                disabled={isBusy}
                className="text-[11px] px-2.5 py-1 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/25 disabled:opacity-50 inline-flex items-center gap-1"
              >
                {isBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Retry
              </button>
              <button
                type="button"
                onClick={() => dismiss(ev)}
                disabled={isBusy}
                className="text-[11px] px-2.5 py-1 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-mid disabled:opacity-50 inline-flex items-center gap-1"
              >
                <Check size={11} /> Mark reviewed
              </button>
              {myResult && (
                <span className={`text-[11px] ${myResult.kind === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
                  {myResult.text}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
