'use client'

// EMAIL-TICKET.5 — the per-user email signature editor, on /account.
//
// It lives here rather than in a ticket-inbox setting because a signature is a
// person's name and role, not a studio's configuration: someone working two
// studios signs off the same way in both (mig 493 stores it on profiles, not
// per location). /account is where every other self-service preference lives.
//
// Saves via PATCH /api/me/preferences — the same route AccountForm uses, and
// the same authorisation model: there is no `id` parameter, so the server
// writes profiles.id = getCurrentUser().id and nothing else. A user cannot
// rewrite what a colleague's replies go out signed as.
//
// PLAIN TEXT. The textarea is plain, the column is plain, and the reply route
// escapes it with the same three replacements it uses on the reply body.
// Anything HTML-shaped typed in here goes out as literal characters, which is
// the point: it is the one path where an operator's own text reaches outbound
// mail, so it must not be a markup path.

import { useState } from 'react'
import { Check, AlertCircle, Loader2 } from 'lucide-react'
import { MAX_SIGNATURE_LENGTH, SIGNATURE_SEPARATOR, normalizeSignature } from '@/lib/email-signature'
import RichSignatureEditor from '@/components/account/RichSignatureEditor'
import { markSignatureUpdated } from '@/components/tickets/SignatureHint'

// MAIL-SIG.1 adds the structured rich signature as a section of this card
// (RichSignatureEditor — toggle, fields, photo, links, sandboxed preview).
// The plain-text editor above it is UNCHANGED on purpose: it is the fallback
// whenever the rich signature is off or can't render. The two sections save
// independently — the plain path's behaviour is byte-for-byte what shipped
// with EMAIL-TICKET.5.
//
// MAILFIX-SIGTRUTH.1 — this card is the ONLY editor for both signatures.
// There is no mobile editor (an earlier comment here claimed the mobile app
// edited the plain column — it never did); on a phone, this same page at
// crm.repset.ie/account is the way to change either one.
//
// MAIL-SIGDEFAULT.1 — the STUDIO block (the sending studio's name, phone and
// links, set on its Email settings card) now goes out on every send, opted
// in or not. Everything on this card is the PERSON'S part: the plain text is
// their own sign-off (it rides ABOVE the studio block), and the rich toggle
// below adds name/role/photo. The live plain value is handed to the rich
// editor so its preview can show the plain-over-studio send while the toggle
// is off — the same resolver the send routes run.

export default function EmailSignatureForm({ initialSignature = '', initialRich = null }) {
  const [signature, setSignature] = useState(initialSignature || '')
  const [saved, setSaved] = useState(normalizeSignature(initialSignature))
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null) // 'saved' | 'error'
  const [error, setError] = useState(null)

  const normalized = normalizeSignature(signature)
  const dirty = normalized !== saved

  async function handleSave() {
    setSaving(true); setStatus(null); setError(null)
    try {
      const res = await fetch('/api/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_signature: normalized }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error || 'Failed to save')
      setSaved(normalized)
      // A composer left open in another tab refetches on this signal
      // (SignatureHint listens for the storage event).
      markSignatureUpdated()
      setStatus('saved')
      setTimeout(() => setStatus(null), 2500)
    } catch (e) {
      setStatus('error')
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-semibold text-un1t-text">Email signature</h2>
        <p className="text-xs text-un1t-subtle mt-1">
          Added to the end of every email you send from the inbox — never to internal notes, which
          are never sent to anyone. Your studio’s signature block (its name, phone and links, set on
          the studio’s Email settings) is added for everyone automatically. What you write here is
          your own sign-off, added above it.
        </p>
      </div>

      <div className="border-t border-un1t-border px-5 py-4">
        <label className="sr-only" htmlFor="email-signature">Email signature</label>
        <textarea
          id="email-signature"
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          rows={4}
          maxLength={MAX_SIGNATURE_LENGTH}
          disabled={saving}
          // Role-only, like the rich Title placeholder: the studio's name and
          // phone follow the account you send from and are added underneath,
          // so inviting them here would double them on a real send.
          placeholder={'Sarah Doyle\nHead Coach'}
          className="w-full resize-none rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text focus:border-un1t-accent focus:outline-none disabled:opacity-60"
        />
        <p className="mt-1.5 text-[11px] text-un1t-muted">
          Plain text only — {normalized.length}/{MAX_SIGNATURE_LENGTH} characters.
        </p>

        {normalized && (
          <div className="mt-3 rounded-lg border border-dashed border-un1t-border bg-un1t-bg px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-un1t-muted">
              How it lands
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-un1t-subtle">
              {`…your reply\n\n${SIGNATURE_SEPARATOR}\n${normalized}`}
            </pre>
          </div>
        )}
      </div>

      <div className="px-5 py-4 border-t border-un1t-border flex items-center justify-between gap-3">
        <div className="min-h-5 text-xs">
          {status === 'saved' && (
            <span className="flex items-center gap-1.5 text-emerald-500">
              <Check size={14} /> Saved
            </span>
          )}
          {status === 'error' && (
            <span className="flex items-center gap-1.5 text-red-500">
              <AlertCircle size={14} /> {error}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            dirty && !saving
              ? 'bg-un1t-text text-un1t-bg hover:bg-un1t-text/90'
              : 'bg-un1t-border text-un1t-subtle cursor-not-allowed'
          }`}
        >
          {saving ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" /> Saving…
            </span>
          ) : 'Save'}
        </button>
      </div>

      <RichSignatureEditor initialRich={initialRich} plainSignature={normalized} />
    </div>
  )
}
