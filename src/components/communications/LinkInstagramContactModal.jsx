'use client'

import { useState, useEffect, useCallback } from 'react'
import { Modal, Button } from '@/components/ui'

// IG-LINK.1 — attach an Instagram thread to a CRM contact.
//
// Instagram gives no phone or email, so there is no automatic key like
// WhatsApp's number: the first time we meet someone, a human says who they
// are. After that the IGSID is remembered on the contact and every later
// thread links itself.
//
// Suggestions are ranked from the Instagram display name/handle and are
// advisory ONLY — the operator confirms. Same-name people are exactly the
// case this guards against, so the list shows enough detail (email/phone) to
// tell two Sarah Byrnes apart.

function scoreLabel(score) {
  if (score === null || score === undefined) return null
  if (score >= 100) return 'Exact name match'
  if (score >= 80) return 'Handle matches'
  if (score >= 60) return 'Name matches'
  return 'Possible match'
}

export default function LinkInstagramContactModal({ open, onClose, conversation, onLinked }) {
  const [results, setResults] = useState([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const conversationId = conversation?.id

  const load = useCallback(async (query) => {
    if (!conversationId) return
    setLoading(true); setError(null)
    try {
      const qs = query ? `?q=${encodeURIComponent(query)}` : ''
      const res = await fetch(`/api/instagram/conversations/${conversationId}/link${qs}`)
      const j = await res.json()
      if (j.success) setResults(j.results || [])
      else setError(j.error || 'Could not load contacts')
    } catch { setError('Could not load contacts') }
    finally { setLoading(false) }
  }, [conversationId])

  useEffect(() => {
    if (!open) return
    setQ('')
    load('')
  }, [open, load])

  // Debounce the search so typing doesn't hammer the route.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => load(q.trim()), q.trim() ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, open, load])

  async function linkTo(contactId) {
    setBusyId(contactId); setError(null)
    try {
      const res = await fetch(`/api/instagram/conversations/${conversationId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      })
      const j = await res.json()
      if (j.success) { onLinked?.(); onClose?.() }
      else setError(j.error || 'Could not link')
    } catch { setError('Could not link') }
    finally { setBusyId(null) }
  }

  async function createContact() {
    setBusyId('new'); setError(null)
    try {
      const res = await fetch(`/api/instagram/conversations/${conversationId}/add-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = await res.json()
      if (j.success) { onLinked?.(); onClose?.() }
      else setError(j.error || 'Could not create the contact')
    } catch { setError('Could not create the contact') }
    finally { setBusyId(null) }
  }

  const igName = conversation?.customer_name
    || (conversation?.ig_username ? `@${conversation.ig_username}` : 'this Instagram user')

  return (
    <Modal open={open} onClose={onClose} title="Link to a contact" size="md">
      <p className="text-sm text-un1t-muted mb-3">
        Who is <span className="text-un1t-text font-medium">{igName}</span>? Instagram doesn&apos;t share a
        phone or email, so pick the person once — after this, their future messages link automatically.
      </p>

      <input
        className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text mb-3"
        placeholder="Search contacts by name, email or phone"
        value={q}
        onChange={e => setQ(e.target.value)}
        autoComplete="off"
      />

      {error && <div className="text-sm text-red-600 mb-2">{error}</div>}
      {loading && <div className="text-sm text-un1t-muted">Searching…</div>}

      {!loading && results.length === 0 && (
        <div className="text-sm text-un1t-muted py-2">
          {q.trim() ? 'No contacts match that search.' : 'No likely matches — search above, or create a new contact.'}
        </div>
      )}

      <ul className="divide-y divide-un1t-border/60 max-h-72 overflow-y-auto">
        {results.map(({ contact, score }) => (
          <li key={contact.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="text-sm text-un1t-text truncate">{contact.name}</div>
              <div className="text-xs text-un1t-muted truncate">
                {[contact.email, contact.phone].filter(Boolean).join(' · ') || 'No email or phone on file'}
              </div>
              {scoreLabel(score) && (
                <div className="text-[11px] text-un1t-muted mt-0.5">{scoreLabel(score)}</div>
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => linkTo(contact.id)}
              disabled={!!busyId}
            >
              {busyId === contact.id ? 'Linking…' : 'Link'}
            </Button>
          </li>
        ))}
      </ul>

      <div className="mt-4 pt-3 border-t border-un1t-border">
        <Button type="button" onClick={createContact} disabled={!!busyId}>
          {busyId === 'new' ? 'Creating…' : 'Create a new contact instead'}
        </Button>
        <p className="text-xs text-un1t-muted mt-2">
          Creates a contact from their Instagram name and handle. You can add an email or phone later.
        </p>
      </div>
    </Modal>
  )
}
