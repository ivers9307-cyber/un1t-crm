'use client'

// CANCEL-FORM.4 — "Send cancellation form": staff pick a channel, see the
// exact text the member will get (operator copy, rendered), optionally edit
// it for this one send, and send. Reached from PersonActionBar.
//
// Reads GET /api/contacts/[id]/cancellation-form for what is possible right
// now (address bounced? phone? WhatsApp window open? template ready?) and
// the latest issued link, so a re-send is a deliberate choice.

import { useEffect, useState } from 'react'
import { Mail, MessageCircle, X } from 'lucide-react'

const INPUT = 'w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted'

function ago(iso) {
  if (!iso) return ''
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export function linkStatus(link) {
  if (!link) return null
  if (link.revoked_at) return { key: 'revoked', label: 'Last link failed to send' }
  if (link.used_at) return { key: 'submitted', label: `Form submitted ${ago(link.used_at)}` }
  if (Date.parse(link.expires_at || '') < Date.now()) return { key: 'expired', label: `Last link expired` }
  if (link.opened_at) return { key: 'opened', label: `Form opened ${ago(link.opened_at)}, not submitted` }
  return { key: 'sent', label: `Form sent ${ago(link.issued_at)} by ${link.channel === 'whatsapp' ? 'WhatsApp' : 'email'}, not opened yet` }
}

export default function SendCancellationFormModal({ contactId, onClose, onSent }) {
  const [info, setInfo] = useState(null)
  const [channel, setChannel] = useState(null)
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/contacts/${contactId}/cancellation-form`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j.success) { setError(j.error || 'Could not load'); return }
        setInfo(j.data)
        setChannel(j.data.can.email ? 'email' : j.data.can.whatsapp ? 'whatsapp' : null)
      })
      .catch(() => { if (!cancelled) setError('Could not load') })
    return () => { cancelled = true }
  }, [contactId])

  async function send() {
    if (!channel) return
    setSending(true); setError(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/cancellation-form`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, ...(editing && message.trim() ? { message: message.trim() } : {}) }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) {
        setError(j.error || 'Could not send')
        if (j.needs_template && info?.can?.email) setChannel('email')
        return
      }
      setDone(j.data)
      onSent?.(j.data)
    } catch {
      setError('Could not send')
    } finally {
      setSending(false)
    }
  }

  const status = linkStatus(info?.latest)
  const preview = info?.preview
  const previewText = channel === 'whatsapp' ? preview?.whatsapp_text : preview?.email_body

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="bg-un1t-surface border border-un1t-border rounded-lg p-4 w-[28rem] max-w-full shadow-lg space-y-3"
      role="dialog"
      aria-label="Send cancellation form"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-un1t-text">Send cancellation form</h3>
          <p className="text-xs text-un1t-muted mt-0.5">
            A private, single-use link where the member can pause or cancel. Their answer lands in Approvals.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-un1t-subtle hover:text-un1t-text" aria-label="Close"><X size={16} /></button>
      </div>

      {!info && !error && <p className="text-xs text-un1t-muted">Loading…</p>}

      {done ? (
        <div className="text-sm text-un1t-text">
          Sent by {done.channel === 'whatsapp' ? 'WhatsApp' : 'email'}. The link works for 30 days and once.
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium">Done</button>
          </div>
        </div>
      ) : info && (
        <>
          {status && (
            <p className={`text-xs px-2 py-1 rounded ${status.key === 'submitted' ? 'bg-red-500/10 text-red-700' : status.key === 'opened' ? 'bg-amber-500/10 text-amber-700' : 'bg-gray-500/10 text-gray-600'}`}>
              {status.label}.{status.key === 'submitted' ? ' Sending again issues a fresh link.' : ''}
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!info.can.email}
              onClick={() => setChannel('email')}
              title={!info.can.has_email ? 'No email address on file' : info.can.email_blocked ? 'Address has bounced or complained' : ''}
              className={`flex items-center gap-2 border rounded px-3 py-2 text-sm ${channel === 'email' ? 'border-un1t-text bg-un1t-border/40' : 'border-un1t-border'} disabled:opacity-40`}
            >
              <Mail size={14} /> Email
            </button>
            <button
              type="button"
              disabled={!info.can.whatsapp}
              onClick={() => setChannel('whatsapp')}
              title={!info.can.has_phone ? 'No phone number on file' : !info.can.whatsapp_window_open && !info.can.whatsapp_template_ready ? 'No open 24h window and no approved template configured' : ''}
              className={`flex items-center gap-2 border rounded px-3 py-2 text-sm ${channel === 'whatsapp' ? 'border-un1t-text bg-un1t-border/40' : 'border-un1t-border'} disabled:opacity-40`}
            >
              <MessageCircle size={14} /> WhatsApp
            </button>
          </div>
          {channel === 'whatsapp' && !info.can.whatsapp_window_open && info.can.whatsapp_template_ready && (
            <p className="text-xs text-un1t-muted">Their 24h window is closed, so this goes as the approved template with the link on its button.</p>
          )}
          {!info.can.email && !info.can.whatsapp && (
            <p className="text-xs text-red-700">Neither channel can carry this right now: check the email address and phone number, or configure the WhatsApp template in Settings → Customer agent.</p>
          )}

          {channel && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-un1t-text">{channel === 'email' ? `Email: ${preview.email_subject}` : 'WhatsApp message'}</span>
                <button type="button" onClick={() => { setEditing((e) => !e); if (!editing) setMessage(previewText || '') }} className="text-xs text-un1t-subtle hover:text-un1t-text">
                  {editing ? 'Use the default' : 'Edit this message'}
                </button>
              </div>
              {editing ? (
                <textarea className={INPUT} rows={6} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
              ) : (
                <pre className="whitespace-pre-wrap text-xs text-un1t-muted bg-un1t-bg border border-un1t-border rounded p-2 max-h-48 overflow-auto font-body">{previewText}</pre>
              )}
              <p className="text-[11px] text-un1t-subtle mt-1">
                {channel === 'email' ? 'The link is inserted where {link} appears (or appended). ' : 'The link goes on a tappable button under the message. '}
                Defaults are editable in Settings → Customer agent.
              </p>
            </div>
          )}

          {error && <p className="text-xs text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="text-xs text-un1t-subtle hover:text-un1t-text">Cancel</button>
            <button type="button" disabled={!channel || sending} onClick={send}
              className="text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50">
              {sending ? 'Sending…' : status?.key === 'sent' || status?.key === 'opened' ? 'Send again' : 'Send'}
            </button>
          </div>
        </>
      )}
      {error && !info && <p className="text-xs text-red-700">{error}</p>}
    </div>
  )
}
