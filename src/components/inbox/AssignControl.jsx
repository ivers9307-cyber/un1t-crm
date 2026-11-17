'use client'

// INBOXASSIGN.1 — "Assigned to …" in a thread header, shared by the
// WhatsApp, Instagram and Mail threads (one code path; Instagram is wired the
// same way even though no Instagram account is connected today).
//
// A plain <select>: Unassigned, then the staff who can work this thread at
// its studio (names only, from GET …/assign). Picking one POSTs to the same
// route; "me" is sent for the viewer's own row so a master or org admin with
// no membership row can still take a thread. A failed load or write shows its
// reason under the control and the select snaps back to what the server
// last said; nothing is ever assumed saved.

import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { assignEndpoint, ownerSentence } from '@/lib/inbox-owner'

const LOAD_FAILED = 'Could not load who can take this conversation.'
const SAVE_FAILED = 'Could not change who owns this conversation. Try again.'

export default function AssignControl({ channel, conversationId, assignedTo = null, onChanged, className = '' }) {
  const url = assignEndpoint(channel, conversationId)
  const [owner, setOwner] = useState(assignedTo || null)
  const [ownerName, setOwnerName] = useState(null)
  const [viewerId, setViewerId] = useState(null)
  const [staff, setStaff] = useState(null) // null = not loaded
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Re-read whenever the thread or its stored owner changes (a colleague's
  // assignment arrives through the parent's own refresh).
  useEffect(() => {
    let cancelled = false
    setOwner(assignedTo || null)
    setError(null)
    if (!url) return undefined
    ;(async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' })
        const body = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok || !body?.success) { setError(body?.error || LOAD_FAILED); setStaff([]); return }
        setOwner(body.data?.assigned_to || null)
        setOwnerName(body.data?.assignee_name || null)
        setViewerId(body.data?.viewer_id || null)
        setStaff(Array.isArray(body.data?.staff) ? body.data.staff : [])
      } catch {
        if (!cancelled) { setError(LOAD_FAILED); setStaff([]) }
      }
    })()
    return () => { cancelled = true }
  }, [url, assignedTo])

  async function choose(value) {
    if (busy || !url) return
    const next = value || null
    if (next === owner) return
    const assignee = next === null ? null : (next === viewerId ? 'me' : next)
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok && body?.success) {
        setOwner(body.data?.assigned_to || null)
        setOwnerName(body.data?.assignee_name || null)
        onChanged?.(body.data)
      } else {
        setError(body?.error || SAVE_FAILED)
      }
    } catch {
      setError(SAVE_FAILED)
    } finally {
      setBusy(false)
    }
  }

  if (!url) return null

  // The options: the viewer first (as "Me"), then colleagues A→Z. An owner who
  // is no longer assignable here (left the studio, lost the channel) is kept
  // as a visible option so the select never silently shows someone else.
  const list = staff || []
  const me = viewerId ? list.find(s => s.id === viewerId) : null
  const others = list.filter(s => s.id !== viewerId)
  const ownerListed = !owner || owner === viewerId || list.some(s => s.id === owner)
  const sentence = ownerSentence({ assignedTo: owner, assigneeName: ownerName, viewerId })

  return (
    <div className={`flex flex-col items-end ${className}`}>
      <label className="flex items-center gap-1 text-xs text-un1t-subtle">
        <UserRound size={12} aria-hidden="true" />
        <span className="sr-only">Assigned to</span>
        <select
          aria-label="Assigned to"
          title={sentence}
          value={owner || ''}
          disabled={busy || staff === null}
          onChange={e => choose(e.target.value)}
          className="max-w-[160px] truncate rounded-md border border-un1t-border bg-un1t-surface px-1.5 py-1 text-xs text-un1t-text disabled:opacity-60"
        >
          <option value="">Unassigned</option>
          {viewerId && <option value={viewerId}>{me?.full_name ? `Me (${me.full_name})` : 'Me'}</option>}
          {others.map(s => (
            <option key={s.id} value={s.id}>{s.full_name || 'Unnamed staff member'}</option>
          ))}
          {!ownerListed && (
            <option value={owner}>{ownerName ? `${ownerName} (cannot work this thread now)` : 'Someone who cannot work this thread now'}</option>
          )}
        </select>
      </label>
      {error && <p role="alert" className="mt-0.5 max-w-[220px] text-right text-[11px] text-red-700">{error}</p>}
    </div>
  )
}
