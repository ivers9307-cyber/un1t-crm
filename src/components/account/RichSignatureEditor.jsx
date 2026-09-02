'use client'

// MAIL-SIG.1 — the rich-signature editor section of the /account card.
//
// Structured FIELDS, never markup: the operator types name/title/phone/note,
// uploads a headshot, and lists up to MAX_SIGNATURE_LINKS http(s) links. The
// shared renderer (renderRichSignature, src/lib/email-signature.js) is the
// ONLY thing that turns those fields into HTML — the preview here calls the
// exact same function the send path calls, inside a fully sandboxed iframe
// (sandbox="", srcDoc — no scripts, no same-origin). The rendered HTML is
// never written into the page's own DOM: it exists only as the iframe's
// srcDoc attribute, so nothing an operator types can execute in the CRM.
//
// The toggle maps to email_signature_rich.enabled. Off, the plain-text
// signature above this section is what goes out (and what the mobile app
// edits) — this section then only holds the drafted fields for later.
//
// photo_url is only ever set from POST /api/me/signature-photo's response —
// /api/me/preferences refuses any other origin, so hand-typing a URL is not
// offered at all.
//
// All branchable logic lives in ./rich-signature-draft.js (tested there);
// this file is the shell.

import { useRef, useState } from 'react'
import { Check, AlertCircle, Plus, X, Upload, ImageOff } from 'lucide-react'
import { Button, Field } from '@/components/ui'
import { renderRichSignature } from '@/lib/email-signature'
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

export default function RichSignatureEditor({ initialRich = null }) {
  const [draft, setDraft] = useState(() => richDraftFromSaved(initialRich))
  const [savedPayload, setSavedPayload] = useState(() => buildRichPayload(richDraftFromSaved(initialRich)))
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null) // 'saved' | 'error'
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const fileRef = useRef(null)

  const payload = buildRichPayload(draft)
  const errors = richDraftErrors(draft)
  const dirty = !payloadsEqual(payload, savedPayload)
  const srcDoc = draft.enabled ? richPreviewSrcDoc(payload) : null
  const previewText = draft.enabled ? renderRichSignature({ ...payload, enabled: true })?.text : null

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
            out, and it’s what the mobile app edits.
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

          {/* Fields */}
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
                  maxLength={RICH_FIELD_CAPS.title} placeholder="Head Coach, UN1T Stillorgan" className={inputClass} />
              )}
            </Field>
            <Field id="sig-rich-phone" label="Phone">
              {(props) => (
                <input {...props} value={draft.phone} onChange={set('phone')} disabled={saving}
                  maxLength={RICH_FIELD_CAPS.phone} placeholder="01 234 5678" className={inputClass} />
              )}
            </Field>
            <Field id="sig-rich-note" label="Note">
              {(props) => (
                <input {...props} value={draft.note} onChange={set('note')} disabled={saving}
                  maxLength={RICH_FIELD_CAPS.note} placeholder="Book a class: reply to this email" className={inputClass} />
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

          {/* Preview — the shared renderer inside a sandboxed iframe. */}
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-un1t-muted">
              How it lands
            </div>
            {srcDoc ? (
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
