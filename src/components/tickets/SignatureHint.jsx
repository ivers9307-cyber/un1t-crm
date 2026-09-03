'use client'

// The auto-appended sign-off preview, shared by every composer that rides a
// ticket send — the reply box, New email, Forward, and the contact profile's
// Mail-backed Email tab (EMAIL-TICKET.5 follow-up, 2026-08-08 audit; widened
// in MAILFIX-SIGTRUTH.1). Every one of those routes appends the effective
// signature server-side; a composer that hides what the server will add has
// operators typing their name twice — or worse, trusting a preview that
// disagrees with what the member receives.
//
// MAILFIX-SIGTRUTH.1 — the hint shows the EFFECTIVE signature for the actual
// sending context, not the plain column. The audit found the old hint
// reading only `email_signature`: with the rich signature enabled and the
// plain box empty it HID while a full block still went out, and with both set
// it previewed the wrong text. It now resolves through the same exported
// functions the send routes run — richSignatureFromProfile gate, then
// renderRichSignature(effectiveRichSignature(rich, ctx)) for the sending
// location, else the plain column — via resolveSignatureHint
// (src/lib/signature-context.js), over the signature context the
// preferences GET carries.
//
// `locationId` IS THE SENDING CONTEXT: the ticket's location on a reply or
// forward, the selected From mailbox's location on a compose — so switching
// the From account re-resolves the hint to that studio's phone/links/name,
// exactly as the send would. Resolution is pure and client-side; no refetch
// per switch. A location the caller has no context for resolves to NULL and
// the hint HIDES — it never shows the person's unresolved values (the send
// always resolves a studio, so an unresolved preview is of an email that
// will never exist). Callers that have no sending context yet (compose with
// no From account) do not mount the hint at all.
//
// A PHOTO-ONLY rich signature has no text part: the send appends no "-- "
// separator and no text, only the HTML block. The hint then shows the label
// and the suffix line and no text block — never an empty "-- ".
//
// FETCHED PER MOUNT, DELIBERATELY — no module memo. A memo was tried and
// removed: it is per TAB, not per viewer, so on the shared kiosk Mac a
// client-side sign-out/sign-in (signOut({scope:'local'}) + router.push, no
// hard navigation) showed user B the previous user's signature until it
// expired; and it made the reply box STALER than a plain fetch, since the
// box remounts per ticket. Three bounded reads per composer mount is the
// right cost. The signature belongs to the VIEWER, not the ticket, so it is
// fetched here rather than threaded through props that have nothing else
// to do with it. A failed lookup just hides the preview — the route appends
// the signature server-side either way, so this is cosmetic.
//
// A MOUNTED COMPOSER MUST NEVER GO STALE EITHER. The "Edit signature" link
// below opens /account in a NEW tab, so the designed edit flow is "edit
// over there, come back here" — and the composer that was left open has to
// notice. Two triggers, both refetching the same GET:
//   • a `storage` event for SIGNATURE_UPDATED_KEY — both /account editors
//     write it on a successful save (markSignatureUpdated), and the browser
//     fires `storage` in every OTHER tab of the origin natively;
//   • the tab regaining visibility (`visibilitychange` → visible), for the
//     paths that leave no storage trace (another device, a colleague's
//     admin edit), throttled to one refetch per 5s so a flurry of tab
//     switches is one read. The mount fetch does not count against the
//     throttle — the first return to the tab always refreshes.
//
// PLAIN TEXT ONLY, still: the rich signature's HTML never renders here (the
// text part is what the hint shows, with a suffix line saying the email
// carries the rich layout). Rendering signature HTML into the page DOM is
// exactly what the /account preview's sandboxed iframe exists to avoid, and
// a hint does not need it.

import { useEffect, useState } from 'react'
import { PenLine } from 'lucide-react'
import { SIGNATURE_SEPARATOR } from '@/lib/email-signature'
import { resolveSignatureHint } from '@/lib/signature-context'

/** The cross-tab "your signature changed" signal. Value is a timestamp. */
export const SIGNATURE_UPDATED_KEY = 'un1t.signature-updated'

/** Visibility-triggered refetches are throttled to one per this window. */
export const VISIBILITY_REFETCH_MIN_MS = 5000

/**
 * The /account editors call this after a successful save. Storage can be
 * unavailable (private mode, quota, a locked-down profile) — a failed mark
 * costs the other tabs their instant refresh, never the save.
 */
export function markSignatureUpdated() {
  try {
    window.localStorage.setItem(SIGNATURE_UPDATED_KEY, String(Date.now()))
  } catch {
    /* storage unavailable — the visibility refetch still covers it */
  }
}

/** The preferences payload (plain + rich + contexts), or null on any failure. */
function loadSignaturePreferences() {
  return fetch('/api/me/preferences')
    .then((r) => r.json())
    .then((j) => (j?.success && j.data ? j.data : null))
    .catch(() => null)
}

// The suffix names exactly what THIS studio's rich send carries — picked from
// the (hasPhoto, hasLinks) pair, so a photo-only signature never promises
// links and a links-only one never promises a photo.
export function richSuffix({ hasPhoto, hasLinks }) {
  if (hasPhoto && hasLinks) return 'The email carries the rich layout — photo and links included.'
  if (hasPhoto) return 'The email carries the rich layout — photo included.'
  if (hasLinks) return 'The email carries the rich layout — links included.'
  return 'The email carries the rich layout.'
}

export default function SignatureHint({ locationId = null }) {
  // The whole preferences payload (plain + rich + contexts) — fetched on
  // mount and refetched on the two triggers above; the per-location
  // resolution below is pure over it.
  const [prefs, setPrefs] = useState(null)

  useEffect(() => {
    let cancelled = false
    let lastVisibilityRefetchAt = 0

    const load = () => {
      loadSignaturePreferences().then((data) => {
        if (!cancelled && data) setPrefs(data)
      })
    }
    load()

    const onStorage = (e) => {
      if (e?.key === SIGNATURE_UPDATED_KEY) load()
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastVisibilityRefetchAt < VISIBILITY_REFETCH_MIN_MS) return
      lastVisibilityRefetchAt = now
      load()
    }
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Mirrors the send decision exactly — see resolveSignatureHint. Null means
  // NOTHING will be appended (or the studio cannot be resolved), and the
  // hint hides; anything else means a block WILL go out, so the hint shows
  // whether or not the plain column has a value.
  const hint = resolveSignatureHint(prefs, locationId)
  if (!hint) return null
  const hasTextPart = hint.text.length > 0

  return (
    /* Deliberately NOT an input: it sits outside the textarea, carries its
       own label, and links to where it is actually changed. */
    <div className="mt-2 rounded-lg border border-dashed border-un1t-border bg-un1t-surface/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-un1t-muted">
          <PenLine size={11} aria-hidden="true" />
          Added automatically
        </span>
        {/* A new tab, not a <Link> soft-nav: navigating away would discard
            whatever draft is half-written in the composer around this hint.
            The refetch triggers above are what make "edit over there, come
            back" show the new signature here. */}
        <a
          href="/account"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-un1t-subtle underline decoration-dotted underline-offset-2 hover:text-un1t-text"
        >
          Edit signature
        </a>
      </div>
      {/* No text part (photo-only) → no separator: the send appends none. */}
      {hasTextPart && (
        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-un1t-subtle">
          {`${SIGNATURE_SEPARATOR}\n${hint.text}`}
        </pre>
      )}
      {hint.rich && (
        <p className="mt-1 text-[10px] text-un1t-muted">
          {richSuffix(hint)}
        </p>
      )}
    </div>
  )
}
