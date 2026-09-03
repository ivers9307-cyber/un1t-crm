'use client'

// CONTACT-COMPOSER.1 — the unified "Message this customer" composer.
//
// DRAWER.4 — channel set is now Note / WhatsApp / SMS / Email, with
// Note FIRST and the default (Richard, 2026-07-13):
//   Note     — staff-visible note; POSTs /api/contacts/[id]/notes so
//              the server attributes the author and pushes the note to
//              Glofox (the ContactActions path — NOT the /api/notes
//              import path, which deliberately skips the push).
//   WhatsApp — free text while the 24h customer-service window is
//              open; a utility-template picker once it's closed.
//   SMS      — free text, always (SMS has no window or template rule).
//   Email    — ad-hoc one-off from the company sender
//              (POST /api/contacts/[id]/email; `email` permission).
//
// Window state is computed server-side at load; the send endpoint is
// the source of truth, so a window_expired response flips the WhatsApp
// view to the template picker.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageCircle, MessageSquare, Send, StickyNote, Mail } from 'lucide-react'
import SignatureHint from '@/components/tickets/SignatureHint'

// SMS segment counter — single-segment GSM-7 fits 160 chars;
// concatenated multi-segment messages count 153 chars per segment.
function smsSegmentInfo(text) {
  const len = text.length
  if (len === 0) return { len: 0, segments: 0 }
  if (len <= 160) return { len, segments: 1 }
  return { len, segments: Math.ceil(len / 153) }
}

function formatWhen(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

function ChannelPill({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded font-medium ${
        active ? 'bg-un1t-text text-un1t-bg' : 'border border-un1t-border text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <Icon size={11} /> {label}
    </button>
  )
}

export default function ContactComposer({
  contactId,
  contactName,
  // PROFILE-MAIL.1 — the Mail-backed email path needs the contact's own
  // location (to load the caller's visible accounts there) and address (the
  // compose route takes recipients, not a contact id). Absent props degrade
  // to the company-sender path, so older render sites keep working.
  contactLocationId = null,
  contactEmail = null,
  canWhatsApp = false,
  canSms = false,
  canEmail = false,
  hasWaPhone = false,
  hasPhone = false,
  hasEmail = false,
  smsBlocked = false,
  emailBlocked = false,
  whatsappWindowOpen = false,
  whatsappWindowExpiresAt = null,
  templates = [],
  defaultChannel = 'note',
  onSaved = null,
}) {
  const router = useRouter()
  const waAvailable = canWhatsApp && hasWaPhone
  const smsAvailable = canSms && hasPhone
  const emailAvailable = canEmail && hasEmail

  const [channel, setChannel] = useState(() => {
    const available = { note: true, whatsapp: waAvailable, sms: smsAvailable, email: emailAvailable }
    return available[defaultChannel] ? defaultChannel : 'note'
  })
  const [text, setText] = useState('')
  const [subject, setSubject] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)
  // The window can lapse while the page sits open. The send endpoint
  // re-checks it; a window_expired response flips this to true.
  const [windowClosed, setWindowClosed] = useState(!whatsappWindowOpen)

  const sendable = (templates || []).filter((t) => t.sendable)
  const seg = smsSegmentInfo(text)

  function showFlash(msg) {
    setFlash(msg)
    setTimeout(() => setFlash(null), 5000)
  }

  // The drawer passes onSaved (refetch its bundle); the page relies on
  // a server-component refresh.
  function afterSave() {
    if (onSaved) onSaved()
    else router.refresh()
  }

  // PROFILE-MAIL.1 — the caller's visible email accounts at the CONTACT'S
  // studio. null = not yet answered (footer keeps the company wording, and a
  // send in that window deliberately takes the company path — what the
  // footer says at click time is what happens); [] = none usable (no
  // connected account, or the caller lacks email_inbox / a grant there) —
  // the company path, permanently, exactly as before this feature.
  const [mailboxes, setMailboxes] = useState(null)
  const [mailboxId, setMailboxId] = useState(null)
  useEffect(() => {
    if (!emailAvailable || !contactLocationId || !contactEmail) return
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/email/mail?location_id=${encodeURIComponent(contactLocationId)}`, { cache: 'no-store' })
        const j = await res.json().catch(() => null)
        if (!alive) return
        const boxes = (res.ok && j?.success && Array.isArray(j.data?.mailboxes)) ? j.data.mailboxes : []
        setMailboxes(boxes)
        // Default = the account starred Default on the studio's Email
        // settings card (is_default), else the first visible one.
        setMailboxId(boxes.find(m => m.is_default)?.id || boxes[0]?.id || null)
      } catch {
        if (alive) setMailboxes([])
      }
    })()
    return () => { alive = false }
  }, [emailAvailable, contactLocationId, contactEmail])

  async function post(urlPath, payload) {
    setSending(true)
    setError(null)
    try {
      const res = await fetch(urlPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        if (j.window_expired) setWindowClosed(true)
        setError(j.error || 'Send failed')
        return false
      }
      return true
    } catch (e) {
      setError(e?.message || 'Send failed')
      return false
    } finally {
      setSending(false)
    }
  }

  async function saveNote() {
    if (!text.trim()) return
    const ok = await post(`/api/contacts/${contactId}/notes`, { content: text.trim() })
    if (ok) { setText(''); showFlash('Note saved'); afterSave() }
  }

  async function sendWhatsAppText() {
    if (!text.trim()) return
    const ok = await post(`/api/contacts/${contactId}/whatsapp`, { text: text.trim() })
    if (ok) { setText(''); showFlash('WhatsApp message sent'); afterSave() }
  }

  async function sendTemplate(name) {
    const ok = await post(`/api/contacts/${contactId}/whatsapp`, { template_name: name })
    if (ok) { showFlash('WhatsApp template sent'); afterSave() }
  }

  async function sendSms() {
    if (!text.trim()) return
    const ok = await post(`/api/contacts/${contactId}/sms`, { body: text.trim() })
    if (ok) { setText(''); showFlash('SMS sent'); afterSave() }
  }

  async function sendEmail() {
    if (!text.trim() || !subject.trim()) return
    // PROFILE-MAIL.1 — with a usable account, the send IS a Mail compose:
    // it goes out from that address and files a conversation the reply
    // threads back into. Without one, the company-sender path is unchanged.
    if (mailboxId && contactEmail) {
      const ok = await post('/api/email/tickets/compose', {
        mailbox_id: mailboxId,
        to: [contactEmail],
        subject: subject.trim(),
        text: text.trim(),
      })
      if (ok) { setText(''); setSubject(''); showFlash('Email sent — the conversation is in Mail'); afterSave() }
      return
    }
    const ok = await post(`/api/contacts/${contactId}/email`, { subject: subject.trim(), body: text.trim() })
    if (ok) { setText(''); setSubject(''); showFlash('Email sent'); afterSave() }
  }

  // Note first — Richard's call. Unavailable channels drop out rather
  // than render disabled.
  const pills = [
    { id: 'note', label: 'Note', icon: StickyNote, available: true },
    { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, available: waAvailable },
    { id: 'sms', label: 'SMS', icon: MessageSquare, available: smsAvailable },
    { id: 'email', label: 'Email', icon: Mail, available: emailAvailable },
  ].filter((p) => p.available)

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 mb-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
          {channel === 'note' ? 'Add a note' : `Message ${contactName || 'contact'}`}
        </h3>
        {pills.length > 1 && (
          <div className="flex gap-1">
            {pills.map((p) => (
              <ChannelPill
                key={p.id}
                active={channel === p.id}
                onClick={() => { setChannel(p.id); setError(null) }}
                icon={p.icon}
                label={p.label}
              />
            ))}
          </div>
        )}
      </div>

      {flash && (
        <p className="mb-2 text-xs text-green-700 bg-green-500/10 border border-green-500/30 rounded px-2 py-1.5">
          {flash}
        </p>
      )}

      {/* Note */}
      {channel === 'note' && (
        <div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={20000}
            placeholder={`Add a note about ${contactName || 'this contact'}…`}
            className="w-full bg-un1t-bg border border-un1t-border rounded p-2 text-sm text-un1t-text placeholder:text-un1t-muted resize-none focus:outline-none focus:border-un1t-muted"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px] text-un1t-muted">Visible to staff only · syncs to Glofox</span>
            <button
              type="button"
              disabled={sending || !text.trim()}
              onClick={saveNote}
              className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50"
            >
              <StickyNote size={12} /> {sending ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </div>
      )}

      {/* WhatsApp */}
      {channel === 'whatsapp' && waAvailable && (
        windowClosed ? (
          <div>
            <p className="text-xs text-un1t-muted mb-2">
              The 24-hour WhatsApp window is closed. Pick a utility template to reopen the
              conversation{smsAvailable ? ', or switch to SMS' : ''}.
            </p>
            {sendable.length === 0 ? (
              <p className="text-xs text-un1t-subtle">
                No approved utility templates yet. Add one under WhatsApp &rarr; Templates
                (category: Utility) and sync.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {sendable.map((t) => (
                  <li key={t.name}
                    className="flex items-start gap-2 rounded border border-un1t-border bg-un1t-bg p-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-un1t-text">{t.name}</p>
                      {t.bodyText && <p className="text-[11px] text-un1t-subtle mt-0.5">{t.bodyText}</p>}
                    </div>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => sendTemplate(t.name)}
                      className="shrink-0 text-xs px-2.5 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50"
                    >
                      Send
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={4096}
              placeholder={`Message ${contactName || 'the customer'} on WhatsApp…`}
              className="w-full bg-un1t-bg border border-un1t-border rounded p-2 text-sm text-un1t-text placeholder:text-un1t-muted resize-none focus:outline-none focus:border-un1t-muted"
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-[11px] text-un1t-muted">
                Free-texting open{whatsappWindowExpiresAt ? ` · closes ${formatWhen(whatsappWindowExpiresAt)}` : ''}
              </span>
              <button
                type="button"
                disabled={sending || !text.trim()}
                onClick={sendWhatsAppText}
                className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50"
              >
                <Send size={12} /> {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        )
      )}

      {/* SMS */}
      {channel === 'sms' && smsAvailable && (
        <div>
          {smsBlocked ? (
            <p className="text-xs text-amber-400">
              This contact has opted out of SMS or the number is marked invalid.
            </p>
          ) : (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={1600}
                placeholder={`Text ${contactName || 'the customer'}…  (merge tags: {{first_name}})`}
                className="w-full bg-un1t-bg border border-un1t-border rounded p-2 text-sm text-un1t-text placeholder:text-un1t-muted resize-none focus:outline-none focus:border-un1t-muted"
              />
              <div className="flex items-center justify-between mt-2">
                <span className={`text-[11px] ${seg.segments > 1 ? 'text-amber-500' : 'text-un1t-muted'}`}>
                  {seg.len} chars · {seg.segments} segment{seg.segments === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  disabled={sending || !text.trim()}
                  onClick={sendSms}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50"
                >
                  <Send size={12} /> {sending ? 'Sending…' : 'Send SMS'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Email */}
      {channel === 'email' && emailAvailable && (
        <div>
          {emailBlocked ? (
            <p className="text-xs text-amber-400">
              This contact&rsquo;s email is bounced, complained or unsubscribed — sends are blocked.
            </p>
          ) : (
            <>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={300}
                placeholder="Subject"
                className="w-full mb-2 bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              />
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={20000}
                placeholder={`Email ${contactName || 'the customer'}…`}
                className="w-full bg-un1t-bg border border-un1t-border rounded p-2 text-sm text-un1t-text placeholder:text-un1t-muted resize-none focus:outline-none focus:border-un1t-muted"
              />
              {/* MAILFIX-SIGTRUTH.1 — the Mail path rides /compose, which
                  appends the sender's effective signature for the chosen
                  account's studio, so it gets the same hint every ticket
                  composer has. ONLY on that path: the company-sender
                  fallback appends nothing, and absence is the truth there. */}
              {mailboxId && contactEmail && (
                <SignatureHint
                  locationId={mailboxes?.find(m => m.id === mailboxId)?.location_id || null}
                />
              )}
              <div className="flex items-center justify-between mt-2 gap-2">
                {mailboxes?.length ? (
                  <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-un1t-muted">
                    From
                    <select
                      value={mailboxId || ''}
                      onChange={(e) => setMailboxId(e.target.value)}
                      className="min-w-0 max-w-[240px] truncate rounded border border-un1t-border bg-un1t-bg px-1.5 py-1 text-[11px] text-un1t-text focus:outline-none focus:border-un1t-muted"
                    >
                      {mailboxes.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.label ? `${m.label} — ${m.address}` : m.address}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="text-[11px] text-un1t-muted">Sent from the company address</span>
                )}
                <button
                  type="button"
                  disabled={sending || !text.trim() || !subject.trim()}
                  onClick={sendEmail}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-un1t-text text-un1t-bg rounded font-medium hover:bg-un1t-accent disabled:opacity-50"
                >
                  <Send size={12} /> {sending ? 'Sending…' : 'Send email'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
          {error}
        </p>
      )}
    </div>
  )
}
