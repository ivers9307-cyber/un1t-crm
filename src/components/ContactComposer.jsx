'use client'

// CONTACT-COMPOSER.1 — the unified "Message this customer" composer.
//
// One box that does the right thing per channel:
//   WhatsApp — free text while the 24h customer-service window is
//              open; a utility-template picker once it's closed.
//   SMS      — free text, always (SMS has no window or template rule).
//
// Window state is computed server-side at page load; the send
// endpoint is the source of truth, so a window_expired response
// flips the WhatsApp view to the template picker.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageCircle, MessageSquare, Send } from 'lucide-react'

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
  canWhatsApp = false,
  canSms = false,
  hasWaPhone = false,
  hasPhone = false,
  smsBlocked = false,
  whatsappWindowOpen = false,
  whatsappWindowExpiresAt = null,
  templates = [],
}) {
  const router = useRouter()
  const waAvailable = canWhatsApp && hasWaPhone
  const smsAvailable = canSms && hasPhone

  const [channel, setChannel] = useState(waAvailable ? 'whatsapp' : 'sms')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)
  // The window can lapse while the page sits open. The send endpoint
  // re-checks it; a window_expired response flips this to true.
  const [windowClosed, setWindowClosed] = useState(!whatsappWindowOpen)

  if (!waAvailable && !smsAvailable) return null

  const sendable = (templates || []).filter((t) => t.sendable)
  const seg = smsSegmentInfo(text)

  function showFlash(msg) {
    setFlash(msg)
    setTimeout(() => setFlash(null), 5000)
  }

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

  async function sendWhatsAppText() {
    if (!text.trim()) return
    const ok = await post(`/api/contacts/${contactId}/whatsapp`, { text: text.trim() })
    if (ok) { setText(''); showFlash('WhatsApp message sent'); router.refresh() }
  }

  async function sendTemplate(name) {
    const ok = await post(`/api/contacts/${contactId}/whatsapp`, { template_name: name })
    if (ok) { showFlash('WhatsApp template sent'); router.refresh() }
  }

  async function sendSms() {
    if (!text.trim()) return
    const ok = await post(`/api/contacts/${contactId}/sms`, { body: text.trim() })
    if (ok) { setText(''); showFlash('SMS sent'); router.refresh() }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 mb-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
          Message {contactName || 'contact'}
        </h3>
        {waAvailable && smsAvailable && (
          <div className="flex gap-1">
            <ChannelPill active={channel === 'whatsapp'} onClick={() => { setChannel('whatsapp'); setError(null) }}
              icon={MessageCircle} label="WhatsApp" />
            <ChannelPill active={channel === 'sms'} onClick={() => { setChannel('sms'); setError(null) }}
              icon={MessageSquare} label="SMS" />
          </div>
        )}
      </div>

      {flash && (
        <p className="mb-2 text-xs text-green-700 bg-green-500/10 border border-green-500/30 rounded px-2 py-1.5">
          {flash}
        </p>
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

      {error && (
        <p className="mt-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
          {error}
        </p>
      )}
    </div>
  )
}
