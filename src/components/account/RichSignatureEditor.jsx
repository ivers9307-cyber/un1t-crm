'use client'

// MAIL-SIG.1 — the rich-signature editor section of the /account card.
//
// Structured FIELDS, never markup: the operator types name/title/phone,
// uploads a headshot, and lists up to MAX_SIGNATURE_LINKS http(s) links. The
// shared renderer (renderRichSignature, src/lib/email-signature.js) is the
// ONLY thing that turns those fields into HTML — the preview here calls the
// exact same function the send path calls, inside a fully sandboxed iframe
// (sandbox="", srcDoc — no scripts, no same-origin). The rendered HTML is
// never written into the page's own DOM: it exists only as the iframe's
// srcDoc attribute, so nothing an operator types can execute in the CRM.
//
// MAILFIX-SIGTRUTH.1 — the preview renders the EFFECTIVE signature, not the
// typed one. Every real send resolves through effectiveRichSignature() with
// the SENDING studio's context: the note line is always the studio name, and
// phone/links are the studio's own whenever its card defines them. The old
// preview showed exactly what was typed, so a coach could see (and believe)
// text that never sends. Now:
//   • the studio context rides GET /api/me/preferences (fetched here on
//     mount). UNTIL IT SETTLES THE PREVIEW SHOWS A PLACEHOLDER, never the
//     un-resolved draft — a first paint of the typed values is a preview of
//     an email that will never exist. Settled but UNRESOLVED (the GET
//     failed, or it offered no studio at all) shows ONE LINE saying the
//     preview is unavailable — no frame, no plain-text pane. The studio
//     line is never absent at send (loadSignatureContext reads the studio
//     name for any location), so there is no truthful "no-studio" preview
//     to fall back to; a frame of the person's own values would be a
//     picture of an email that never goes out;
//   • the preview runs the send's own exported resolver over the LIVE draft,
//     defaulting to the active location, with a small per-studio switch
//     across the studios the caller can SEND from (has_mailbox; if none has
//     a mailbox, every permitted studio is offered so the preview still
//     resolves for a real one);
//   • the NOTE input is gone — the studio line always wins at send, so a
//     typed note cannot survive any send. The field stays accepted
//     server-side (back-compat), a STORED note is stripped from the preview
//     payload unconditionally, so it can never render here again, AND the
//     save always sends note:'' — a legacy value must not reach the wire,
//     since on a blipped locations read at send it is the one value no
//     surface can show or edit;
//   • a successful save marks localStorage (markSignatureUpdated) so a
//     composer left open in another tab refetches — the hint's own "Edit
//     signature" link opens this page in a new tab, so that IS the flow.
//
// The toggle maps to email_signature_rich.enabled. Off, the plain-text
// signature above this section is what goes out — this section then only
// holds the drafted fields for later. (Both are edited HERE, at /account —
// there is no mobile editor; this page works fine in a phone browser.)
//
// photo_url is only ever set from POST /api/me/signature-photo's response —
// /api/me/preferences refuses any other origin, so hand-typing a URL is not
// offered at all.
//
// All branchable logic lives in ./rich-signature-draft.js (tested there) and
// src/lib/signature-context.js; this file is the shell.

import { useEffect, useRef, useState } from 'react'
import { Check, AlertCircle, Plus, X, Upload, ImageOff } from 'lucide-react'
import { Button, Field } from '@/components/ui'
import { renderRichSignature, effectiveRichSignature } from '@/lib/email-signature'
import { signatureContextFor, signatureStudiosToOffer } from '@/lib/signature-context'
import { markSignatureUpdated } from '@/components/tickets/SignatureHint'
import { compressImageForUpload, parseUploadResponse } from '@/lib/landing-media-upload'
import {
  RICH_FIELD_CAPS,
  PHOTO_ACCEPT,
  richDraftFromSaved,
  canAddLink,
  richDraftErrors,
  buildRichPayload,
  payloadsEqual,
  photoFileError,
  richPreviewSrcDoc,
} from './rich-signature-draft'

const inputClass =
  'w-full rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text focus:border-un1t-accent focus:outline-none disabled:opacity-60'

// The note never reaches the wire from here (header). Applied to the save
// payload AND the saved baseline, so a legacy stored note is not a spurious
// "unsaved change" on load — it is simply gone at the next save.
const withoutNote = (p) => ({ ...p, note: '' })

export default function RichSignatureEditor({ initialRich = null }) {
  const [draft, setDraft] = useState(() => richDraftFromSaved(initialRich))
  const [savedPayload, setSavedPayload] = useState(() => withoutNote(buildRichPayload(richDraftFromSaved(initialRich))))
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null) // 'saved' | 'error'
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const fileRef = useRef(null)

  // MAILFIX-SIGTRUTH.1 — the per-studio signature context, off the same GET
  // the composers' hint reads. `contextsLoaded` flips on settle (success OR
  // failure); until then the preview shows a placeholder, never the draft.
  const [contexts, setContexts] = useState([])
  const [contextsLoaded, setContextsLoaded] = useState(false)
  const [previewLocationId, setPreviewLocationId] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/me/preferences')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (j?.success && j.data) {
          const list = Array.isArray(j.data.signature_contexts) ? j.data.signature_contexts : []
          setContexts(list)
          // Chips = studios the caller can SEND from (has_mailbox), else all.
          // Default to the ACTIVE location when it is among them; otherwise
          // the first offered studio.
          const offered = signatureStudiosToOffer(list)
          const active = j.data.active_location_id
          setPreviewLocationId(
            offered.some((c) => c.location_id === active) ? active : (offered[0]?.location_id || null)
          )
        }
        // Set in the SAME callback as the contexts so React batches them into
        // one render — the placeholder must never flash after the caption.
        setContextsLoaded(true)
      })
      .catch(() => { if (!cancelled) setContextsLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const payload = withoutNote(buildRichPayload(draft))
  const errors = richDraftErrors(draft)
  const dirty = !payloadsEqual(payload, savedPayload)

  const offeredStudios = signatureStudiosToOffer(contexts)
  const previewStudioNames = offeredStudios.map((c) => c.location_name).filter(Boolean)
  // Settled, and nothing to resolve against: the GET failed, or it offered
  // no studio. There is no truthful preview in that state (header).
  const unresolved = contextsLoaded && offeredStudios.length === 0

  // THE PREVIEW IS THE SEND, RESOLVED. The NOTE is already stripped (payload
  // above — the studio line replaces it at every send, so a stored note must
  // never render here, on any path). Gate on the RAW draft first, exactly as
  // the send gates on the raw saved value (richSignatureFromProfile): an
  // enabled-but-empty rich signature falls back to the plain column at send,
  // so an empty draft must not preview a studio-line-only block that would
  // never go out. Then resolve the studio half with the send's own exported
  // resolver — live typing re-runs this per keystroke, client-side. Nothing
  // here renders until the context has SETTLED and RESOLVED (see below).
  const previewPayload = { ...payload, enabled: true }
  const rawRendered = draft.enabled && contextsLoaded && !unresolved
    ? renderRichSignature(previewPayload)
    : null
  const effectivePayload = rawRendered
    ? effectiveRichSignature(previewPayload, signatureContextFor(contexts, previewLocationId))
    : null
  const srcDoc = effectivePayload ? richPreviewSrcDoc(effectivePayload) : null
  const previewText = effectivePayload ? renderRichSignature(effectivePayload)?.text : null

  const set = (key) => (e) => {
    const value = e.target.value
    setDraft((d) => ({ ...d, [key]: value }))
  }
  const setLink = (i, key) => (e) => {
    const value = e.target.value
    setDraft((d) => ({
      ...d,
      links: d.links.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)),
    }))
  }

  async function handleSave() {
    setSaving(true)
    setStatus(null)
    setError(null)
    try {
      const res = await fetch('/api/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_signature_rich: payload }),
      })
      const j = await res.json()
      if (!j.success) {
        // A failed save keeps the draft on screen — nothing below resets
        // state — and shows the server's words, issues included.
        const issues = Array.isArray(j.issues) && j.issues.length
          ? ` — ${j.issues.map((i) => i.message).join('; ')}`
          : ''
        throw new Error((j.error || 'Failed to save') + issues)
      }
      setSavedPayload(payload)
      // A composer left open in another tab refetches on this signal.
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

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again after a failure
    if (!file) return
    setUploadError(null)
    // Same helper pair every browser uploader here uses (CLAUDE.md):
    // downscale in the browser, and never bare-.json() the response.
    const toSend = await compressImageForUpload(file)
    const pre = photoFileError(toSend)
    if (pre) {
      setUploadError(pre)
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', toSend, toSend.name || file.name || 'photo')
      const res = await fetch('/api/me/signature-photo', { method: 'POST', body: fd })
      const parsed = await parseUploadResponse(res)
      if (!parsed.success || !parsed.url) throw new Error(parsed.error || 'Upload failed — try again')
      // The response url is the ONLY value photo_url is ever set from.
      setDraft((d) => ({ ...d, photo_url: parsed.url }))
    } catch (err) {
      setUploadError(err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="border-t border-un1t-border px-5 py-4">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={saving}
          onChange={(e) => {
            const enabled = e.target.checked
            setDraft((d) => ({ ...d, enabled }))
          }}
          className="mt-0.5 h-4 w-4 rounded border-un1t-border accent-un1t-accent"
        />
        <span>
          <span className="block text-sm font-medium text-un1t-text">Use the rich signature</span>
          <span className="block text-xs text-un1t-subtle mt-0.5">
            Name, role, photo and links laid out like an email footer. While this is off — and
            anywhere the rich version can’t be used — the plain-text signature above is what goes
            out. Edit either one here, at crm.repset.ie/account — it works in a phone browser too.
          </span>
        </span>
      </label>

      {draft.enabled && (
        <div className="mt-4 space-y-4">
          {/* Photo */}
          <div>
            <div className="mb-1 block text-sm font-medium text-un1t-text">Photo</div>
            {draft.photo_url ? (
              <div className="flex items-center gap-3">
                <img
                  src={draft.photo_url}
                  alt="Signature photo"
                  className="h-14 w-14 rounded-full border border-un1t-border object-cover"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ImageOff}
                  onClick={() => setDraft((d) => ({ ...d, photo_url: null }))}
                >
                  Remove photo
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={Upload}
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                Upload photo
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept={PHOTO_ACCEPT}
              onChange={handleFile}
              className="hidden"
              aria-label="Signature photo file"
            />
            <p className="mt-1 text-[11px] text-un1t-muted">JPEG, PNG or WebP, under 2MB.</p>
            {uploadError && (
              <p role="alert" className="mt-1 text-xs text-red-700">{uploadError}</p>
            )}
          </div>

          {/* Fields. NO NOTE INPUT (MAILFIX-SIGTRUTH.1): the studio line
              always replaces the note at send, so a typed note cannot
              survive any send — offering the box was an invitation to write
              text that never leaves the building. The Title placeholder is
              role-only for the same reason: the studio name follows the
              account you send from, so baking it into the title would render
              "… UN1T Stillorgan · UN1T Stillorgan" on a real send. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="sig-rich-name" label="Name">
              {(props) => (
                <input {...props} value={draft.name} onChange={set('name')} disabled={saving}
                  maxLength={RICH_FIELD_CAPS.name} placeholder="Sarah Doyle" className={inputClass} />
              )}
            </Field>
            <Field id="sig-rich-title" label="Title">
              {(props) => (
                <input {...props} value={draft.title} onChange={set('title')} disabled={saving}
                  maxLength={RICH_FIELD_CAPS.title} placeholder="Head Coach" className={inputClass} />
              )}
            </Field>
            <Field id="sig-rich-phone" label="Phone">
              {(props) => (
                <input {...props} value={draft.phone} onChange={set('phone')} disabled={saving}
                  maxLength={RICH_FIELD_CAPS.phone} placeholder="01 234 5678" className={inputClass} />
              )}
            </Field>
          </div>

          {/* Links */}
          <div>
            <div className="mb-1 block text-sm font-medium text-un1t-text">Links</div>
            <div className="space-y-2">
              {draft.links.map((row, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`Link ${i + 1} label`}
                      value={row.label}
                      onChange={setLink(i, 'label')}
                      disabled={saving}
                      maxLength={RICH_FIELD_CAPS.link_label}
                      placeholder="Instagram"
                      className={`${inputClass} max-w-40`}
                    />
                    <input
                      aria-label={`Link ${i + 1} URL`}
                      value={row.url}
                      onChange={setLink(i, 'url')}
                      disabled={saving}
                      maxLength={RICH_FIELD_CAPS.link_url}
                      placeholder="https://instagram.com/un1tdublin"
                      className={inputClass}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={X}
                      aria-label={`Remove link ${i + 1}`}
                      onClick={() => setDraft((d) => ({ ...d, links: d.links.filter((_, idx) => idx !== i) }))}
                    />
                  </div>
                  {errors.links[i] && (
                    <p role="alert" className="mt-1 text-xs text-red-700">{errors.links[i]}</p>
                  )}
                </div>
              ))}
            </div>
            {canAddLink(draft.links) && (
              <Button
                variant="secondary"
                size="sm"
                icon={Plus}
                className="mt-2"
                onClick={() => setDraft((d) => ({ ...d, links: [...d.links, { label: '', url: '' }] }))}
              >
                Add link
              </Button>
            )}
          </div>

          {/* Preview — the shared renderer inside a sandboxed iframe,
              resolved for the SENDING studio (MAILFIX-SIGTRUTH.1). */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-un1t-muted">
                How it lands
              </div>
              {/* The per-studio switch — only when there is a real choice.
                  Minimal by design: chips, no dropdown ceremony. */}
              {offeredStudios.length > 1 && (
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Preview sending studio">
                  {offeredStudios.map((c) => (
                    <button
                      key={c.location_id}
                      type="button"
                      onClick={() => setPreviewLocationId(c.location_id)}
                      aria-pressed={previewLocationId === c.location_id}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                        previewLocationId === c.location_id
                          ? 'border-transparent bg-un1t-text font-medium text-un1t-bg'
                          : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
                      }`}
                    >
                      {c.location_name || 'Studio'}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!contextsLoaded ? (
              /* Never the un-resolved draft: until the studio context has
                 settled there is nothing truthful to show. */
              <p className="mt-1 text-xs text-un1t-subtle">Resolving your studio…</p>
            ) : unresolved ? (
              /* Settled, nothing to resolve against — one line, no frame, no
                 plain-text pane. The saved signature is unaffected: the send
                 resolves the studio for itself. */
              <p className="mt-1 text-xs text-un1t-subtle">
                Couldn&rsquo;t resolve your studio — the preview is unavailable. Your saved signature
                still sends with the studio&rsquo;s details.
              </p>
            ) : srcDoc ? (
              <>
                <iframe
                  title="Signature preview"
                  sandbox=""
                  srcDoc={srcDoc}
                  className="mt-1 h-44 w-full rounded-lg border border-dashed border-un1t-border bg-white"
                />
                <div className="mt-2 rounded-lg border border-dashed border-un1t-border bg-un1t-bg px-3 py-2">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-un1t-muted">
                    Plain-text version (older mail clients, and the fallback)
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-un1t-subtle">{previewText}</pre>
                </div>
              </>
            ) : (
              <p className="mt-1 text-xs text-un1t-subtle">
                Fill in a field above to see the preview.
              </p>
            )}
            {/* The one quiet caption: which parts follow the sending studio,
                and the studio names they resolve to (the has_mailbox chips —
                a grant-less coach may still be over-offered one, which is
                the smaller harm). */}
            {previewStudioNames.length > 0 && (
              <p className="mt-2 text-[11px] text-un1t-muted">
                The studio name, phone and links follow the account you send from.{' '}
                {previewStudioNames.length === 1
                  ? <>Shown for the studio you can send from: <span className="text-un1t-subtle">{previewStudioNames[0]}</span>.</>
                  : <>Shown for the studios you can send from: <span className="text-un1t-subtle">{previewStudioNames.join(' or ')}</span>, whichever you send from.</>}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="min-h-5 text-xs">
          {status === 'saved' && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700">
              <Check size={14} /> Saved
            </span>
          )}
          {status === 'error' && (
            <span role="alert" className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2 py-0.5 font-medium text-red-700">
              <AlertCircle size={14} /> {error}
            </span>
          )}
        </div>
        <Button onClick={handleSave} loading={saving} disabled={!dirty || !errors.valid}>
          Save rich signature
        </Button>
      </div>
    </div>
  )
}
