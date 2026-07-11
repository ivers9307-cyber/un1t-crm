'use client'

// HOST-EMAIL.3 — the host portal's "Email your contacts" surface: past
// campaigns (subject, status chip, sent/recipients, date), a New email form
// (subject + body), and a per-draft Send button. Send POSTs to
// /api/host/emails/[id]/send — the server owns every gate (verified sender,
// daily cap, consent/suppression, double-send CAS) and its 409 messages are
// user-facing, so they render inline verbatim.
//
// Dark UN1T host-portal styling (bg-black page) — dark-surface chip recipe
// `bg-<c>-500/15 text-<c>-300`; host paths are exempt from the light-theme
// -700 chip rule.

import { useCallback, useEffect, useState } from 'react'

const STATUS_CHIP = {
  draft: 'bg-white/10 text-white/70',
  sending: 'bg-amber-500/15 text-amber-300',
  sent: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}

const STATUS_LABEL = {
  draft: 'Draft',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
}

export default function HostEmails() {
  const [campaigns, setCampaigns] = useState(null) // null = loading
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [sendingId, setSendingId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/host/emails', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.success) setCampaigns(json.data || [])
      else setCampaigns([])
    } catch {
      setCampaigns([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function createDraft(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const res = await fetch('/api/host/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not save the email.')
        return
      }
      setSubject('')
      setBody('')
      setNotice('Draft saved — press Send when you’re ready.')
      await load()
    } catch {
      setError('Could not save the email.')
    } finally {
      setBusy(false)
    }
  }

  async function send(id) {
    if (!window.confirm('Send this email to all your emailable contacts?')) return
    setError('')
    setNotice('')
    setSendingId(id)
    try {
      const res = await fetch(`/api/host/emails/${id}/send`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        // The 409 messages ("Daily send limit reached.", "No emailable
        // contacts.", "Sending is not enabled — …") are user-facing.
        setError(json.error || 'Could not send the email.')
        return
      }
      const n = json.data?.recipient_count || 0
      setNotice(`Sending to ${n} contact${n === 1 ? '' : 's'} — this takes a few minutes.`)
      await load()
    } catch {
      setError('Could not send the email.')
    } finally {
      setSendingId(null)
    }
  }

  const input =
    'w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-white ' +
    'placeholder:text-white/30 focus:outline-none focus:border-white/40'

  return (
    <div>
      {(error || notice) && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            error
              ? 'border-red-500/25 bg-red-500/10 text-red-300'
              : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {error || notice}
        </div>
      )}

      <section className="mt-6">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">New email</h2>
        <form onSubmit={createDraft} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
          <div>
            <label htmlFor="host-email-subject" className="block text-xs text-white/50 mb-1">Subject</label>
            <input
              id="host-email-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              required
              placeholder="e.g. Early-bird tickets are live"
              className={input}
            />
          </div>
          <div>
            <label htmlFor="host-email-body" className="block text-xs text-white/50 mb-1">Message</label>
            <textarea
              id="host-email-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={20000}
              required
              rows={8}
              placeholder="Write your email…"
              className={input}
            />
            <p className="text-[11px] text-white/35 mt-1">
              Sent with your sender name and an unsubscribe link added automatically.
            </p>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save draft'}
          </button>
        </form>
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Your emails</h2>
        {campaigns === null ? (
          <p className="text-white/40 text-sm">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="text-white/50 text-sm">No emails yet — write your first one above.</p>
        ) : (
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
            {campaigns.map((c) => {
              const chip = STATUS_CHIP[c.status] || 'bg-white/10 text-white/70'
              return (
                <li key={c.id} className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{c.subject}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip}`}>
                        {STATUS_LABEL[c.status] || c.status}
                      </span>
                    </p>
                    <p className="text-xs text-white/45 mt-0.5">
                      {c.status === 'draft'
                        ? 'Not sent yet'
                        : `${c.sent_count || 0}/${c.recipient_count ?? '—'} sent`}
                      {' · '}
                      {(c.sent_at || c.created_at || '').slice(0, 10) || '—'}
                    </p>
                  </div>
                  {c.status === 'draft' && (
                    <button
                      type="button"
                      onClick={() => send(c.id)}
                      disabled={sendingId === c.id}
                      className="shrink-0 rounded-lg bg-white text-black text-xs font-semibold px-3 py-1.5 hover:bg-white/90 disabled:opacity-50"
                    >
                      {sendingId === c.id ? 'Sending…' : 'Send'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
