'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Send, Trash2, Upload, FileText, Video, X } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import { validateTemplateMedia } from '@/lib/template-media'
import { extractVariableIndexes, buildBodyExample, buildHeaderTextExample, missingSampleError, samplesFromExample } from '@/lib/whatsapp-template-samples'

// Parse a route response defensively. Infra layers answer in plain text
// (Vercel's ~4.5 MB body cap returns a literal "Request Entity Too
// Large" page) — blind res.json() on that produced the old
// `Unexpected token 'R'` mystery error.
async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { success: false, error: `Upload failed (HTTP ${res.status}): ${text.slice(0, 80)}` }
  }
}

// validateBody() failures return { error: 'Invalid request body',
// issues: [{ path, message }] } — without the issues, the operator sees
// a generic banner with no clue which field to fix. Fold them in.
function errorMessageFrom(result, fallback) {
  const base = result?.error || fallback
  const issues = Array.isArray(result?.issues) ? result.issues : []
  if (issues.length === 0) return base
  const detail = issues.map((i) => `${i.path || 'body'}: ${i.message}`).join('; ')
  return `${base} — ${detail}`
}

// Meta's published caps (May 2026). Same for every template category.
const MEDIA_LIMITS = {
  IMAGE:    { mimes: 'image/jpeg,image/png',          accept: '.jpg,.jpeg,.png',  maxMb: 5,   label: 'JPG or PNG, max 5 MB' },
  VIDEO:    { mimes: 'video/mp4,video/3gpp',          accept: '.mp4,.3gp',        maxMb: 16,  label: 'MP4 or 3GPP, max 16 MB' },
  DOCUMENT: { mimes: 'application/pdf',               accept: '.pdf',             maxMb: 100, label: 'PDF, max 100 MB' },
}

const CATEGORIES = [
  { value: 'MARKETING', label: 'Marketing', description: 'Promotions, offers, updates' },
  { value: 'UTILITY', label: 'Utility', description: 'Order updates, booking confirmations' },
  { value: 'AUTHENTICATION', label: 'Authentication', description: 'OTP and verification codes' },
]

const HEADER_FORMATS = [
  { value: 'NONE', label: 'No header' },
  { value: 'TEXT', label: 'Text' },
  { value: 'IMAGE', label: 'Image' },
  { value: 'VIDEO', label: 'Video' },
  { value: 'DOCUMENT', label: 'Document' },
]

export default function WATemplateEditor({ template, locationId, userId, events = [] }) {
  const router = useRouter()
  const isEditing = !!template
  const isSubmitted = template?.status && template.status !== 'draft'
  const canResubmit = ['REJECTED', 'PAUSED'].includes(template?.status)
  const MANAGER_URL = 'https://business.facebook.com/wa/manage/message-templates/'

  const [name, setName] = useState(template?.name || '')
  const [category, setCategory] = useState(template?.category || 'MARKETING')
  const [language, setLanguage] = useState(template?.language || 'en')
  const [saving, setSaving] = useState(false)
  const [resubmitting, setResubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Component state
  const existingComponents = template?.components || []
  const existingHeader = existingComponents.find(c => c.type === 'HEADER')
  const existingBody = existingComponents.find(c => c.type === 'BODY')
  const existingFooter = existingComponents.find(c => c.type === 'FOOTER')
  const existingButtons = existingComponents.find(c => c.type === 'BUTTONS')

  const [headerFormat, setHeaderFormat] = useState(existingHeader?.format || 'NONE')
  const [headerText, setHeaderText] = useState(existingHeader?.text || '')
  const [bodyText, setBodyText] = useState(existingBody?.text || '')
  const [footerText, setFooterText] = useState(existingFooter?.text || '')
  const [buttons, setButtons] = useState(existingButtons?.buttons || [])

  // Meta requires an example (sample) value per {{n}} variable at CREATE time,
  // or the template is rejected. Seed from the existing template when editing.
  const [bodySamples, setBodySamples] = useState(() => samplesFromExample(existingBody?.example?.body_text?.[0]))
  const [headerSamples, setHeaderSamples] = useState(() => samplesFromExample(existingHeader?.example?.header_text))
  const bodyVars = extractVariableIndexes(bodyText)
  const headerVars = headerFormat === 'TEXT' ? extractVariableIndexes(headerText) : []

  // Header media — handle is what Meta needs at template-approval time;
  // url is what we feed Meta at SEND time. Both come back from
  // /api/whatsapp/templates/upload-media in one round trip.
  const [mediaHandle, setMediaHandle] = useState(template?.header_media_handle || null)
  const [mediaUrl, setMediaUrl] = useState(template?.header_media_url || null)
  const [mediaPath, setMediaPath] = useState(template?.header_media_path || null)
  const [mediaName, setMediaName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const fileInputRef = useRef(null)

  // Three-step upload: the file bytes go DIRECTLY from the browser to
  // Supabase Storage (signed URL) and never transit our API — Vercel
  // caps serverless request bodies at ~4.5 MB, which 413'd every real
  // video (Meta's video cap is 16 MB). See src/lib/template-media.js.
  async function handleMediaUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      // Instant pre-check against Meta's caps — same validator the
      // server enforces; saves uploading a doomed file.
      const pre = validateTemplateMedia({ format: headerFormat, mime: file.type, size: file.size, fileName: file.name })
      if (!pre.ok) {
        setUploadError(pre.error)
        return
      }

      // 1. Mint a signed direct-to-storage upload slot (tiny JSON).
      const signRes = await fetch('/api/whatsapp/templates/upload-media/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          format: headerFormat,
          mime: file.type,
          size: file.size,
          file_name: file.name,
          location_id: locationId || undefined,
        }),
      })
      const sign = await readJson(signRes)
      if (!sign.success) {
        setUploadError(sign.error || 'Could not start the upload')
        return
      }

      // 2. Browser → Supabase Storage directly (bypasses Vercel).
      const supabase = createBrowserClient()
      const { error: upErr } = await supabase.storage
        .from('whatsapp-templates')
        .uploadToSignedUrl(sign.path, sign.token, file, { contentType: file.type })
      if (upErr) {
        setUploadError(`Storage upload failed: ${upErr.message}`)
        return
      }

      // 3. Finalise — the server pulls the object and pushes it through
      //    Meta's resumable upload for the approval handle.
      const res = await fetch('/api/whatsapp/templates/upload-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: sign.path,
          format: headerFormat,
          mime: file.type,
          file_name: file.name,
          location_id: locationId || undefined,
        }),
      })
      const j = await readJson(res)
      if (!j.success) {
        setUploadError(j.error || 'Upload failed')
        return
      }
      setMediaHandle(j.handle)
      setMediaUrl(j.url)
      setMediaPath(j.path)
      setMediaName(j.file_name)
      if (j.meta_error) {
        // Storage upload worked but Meta upload didn't — surface so the
        // operator knows the template won't pass approval until they
        // retry. Picker stays so they can re-upload.
        setUploadError(`Meta upload failed (handle missing): ${j.meta_error}. Try again or contact support.`)
      }
    } catch (err) {
      setUploadError(err.message || 'Network error')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function clearMedia() {
    setMediaHandle(null)
    setMediaUrl(null)
    setMediaPath(null)
    setMediaName('')
    setUploadError(null)
  }

  function buildComponents() {
    const components = []

    if (headerFormat !== 'NONE') {
      const header = { type: 'HEADER', format: headerFormat }
      if (headerFormat === 'TEXT') {
        header.text = headerText
        const headerExample = buildHeaderTextExample(headerText, headerSamples)
        if (headerExample) header.example = headerExample
      } else if (mediaHandle) {
        // Real handle from Meta's Resumable Upload API. Required for
        // IMAGE / VIDEO / DOCUMENT headers — Meta needs an actual
        // example asset to review the template, a placeholder URL
        // gets the template rejected.
        header.example = { header_handle: [mediaHandle] }
      }
      components.push(header)
    }

    if (bodyText) {
      const bodyComp = { type: 'BODY', text: bodyText }
      // Operator-entered sample values → Meta's example.body_text (required for
      // approval when the body has {{n}} variables).
      const bodyExample = buildBodyExample(bodyText, bodySamples)
      if (bodyExample) bodyComp.example = bodyExample
      components.push(bodyComp)
    }

    if (footerText) {
      components.push({ type: 'FOOTER', text: footerText })
    }

    if (buttons.length > 0) {
      components.push({ type: 'BUTTONS', buttons })
    }

    return components
  }

  async function handleSave() {
    if (!name || !bodyText) {
      setError('Template name and body text are required')
      return
    }
    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && !mediaHandle) {
      setError(`A ${headerFormat.toLowerCase()} file must be uploaded before submitting — Meta requires a real example asset for media headers.`)
      return
    }
    const sampleError = missingSampleError({
      bodyText,
      headerText: headerFormat === 'TEXT' ? headerText : '',
      bodySamples,
      headerSamples,
    })
    if (sampleError) {
      setError(sampleError)
      return
    }

    // Meta requires lowercase with underscores only
    const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_')

    setSaving(true)
    setError(null)

    try {
      const payload = {
        name: cleanName,
        category,
        language,
        components: buildComponents(),
        location_id: locationId,
        created_by: userId,
        // Persist the upload metadata so runtime sends can reach the
        // media without operators having to re-supply a URL each time.
        header_media_handle: mediaHandle,
        header_media_url: mediaUrl,
        header_media_path: mediaPath,
      }

      const url = isEditing ? `/api/whatsapp/templates/${template.id}` : '/api/whatsapp/templates'
      const method = isEditing ? 'PUT' : 'POST'

      const result = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(readJson)

      if (!result.success) throw new Error(errorMessageFrom(result, 'Save failed'))

      router.push('/whatsapp/templates')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleResubmit() {
    setResubmitting(true)
    setError(null)
    try {
      const result = await fetch(`/api/whatsapp/templates/${template.id}/resubmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, components: buildComponents() }),
      }).then(readJson)
      if (!result.success) throw new Error(errorMessageFrom(result, 'Resubmit failed'))
      router.push('/communications/templates?channel=whatsapp')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setResubmitting(false)
    }
  }

  function addButton(type) {
    if (buttons.length >= 3) return
    const newButton = type === 'URL'
      ? { type: 'URL', text: '', url: '' }
      : type === 'PHONE_NUMBER'
      ? { type: 'PHONE_NUMBER', text: '', phone_number: '' }
      : { type: 'QUICK_REPLY', text: '' }
    setButtons([...buttons, newButton])
  }

  function updateButton(index, updates) {
    setButtons(buttons.map((b, i) => i === index ? { ...b, ...updates } : b))
  }

  function removeButton(index) {
    setButtons(buttons.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-border bg-un1t-surface shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/whatsapp/templates" className="text-un1t-subtle hover:text-un1t-text transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <h2 className="text-lg font-semibold">
            {isEditing ? 'Edit Template' : 'New Template'}
          </h2>
          {template?.status && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              template.status === 'APPROVED' ? 'bg-green-500/20 text-green-400' :
              template.status === 'REJECTED' ? 'bg-red-500/20 text-red-400' :
              template.status === 'PENDING' ? 'bg-yellow-500/20 text-yellow-400' :
              'bg-gray-500/20 text-gray-400'
            }`}>
              {template.status}
            </span>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving || isSubmitted}
          className="flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {isEditing ? <Save size={14} /> : <Send size={14} />}
          {saving ? 'Submitting...' : isEditing ? 'Update' : 'Submit to Meta'}
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm px-5 py-2">
          {error}
        </div>
      )}

      {template?.rejection_reason && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm px-5 py-2">
          Rejection reason: {template.rejection_reason}
        </div>
      )}

      {isSubmitted && (
        <div className="bg-blue-500/10 border-b border-blue-500/30 text-blue-400 text-sm px-5 py-2">
          This template has been submitted to Meta and cannot be edited. Create a new template if you need changes.
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="flex gap-6 p-6 max-w-6xl">
          {/* Left: Form */}
          <div className="flex-1 space-y-5">
            {template && (canResubmit || events.length > 0) && (
              <div className="mb-4 rounded-lg border border-un1t-border bg-un1t-surface p-4 space-y-3">
                {canResubmit && (
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <span className="font-medium text-amber-700">{template.status}</span>
                      {template.rejection_reason ? <span className="text-un1t-subtle"> — {template.rejection_reason}</span> : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" onClick={handleResubmit} disabled={resubmitting}
                        className="text-sm bg-green-600 text-white px-3 py-1.5 rounded-md hover:bg-green-700 disabled:opacity-50">
                        {resubmitting ? 'Resubmitting…' : 'Edit & resubmit'}
                      </button>
                      <a href={MANAGER_URL} target="_blank" rel="noopener noreferrer"
                        className="text-sm text-un1t-subtle hover:text-un1t-text underline">Appeal in WhatsApp Manager ↗</a>
                    </div>
                  </div>
                )}
                {events.length > 0 && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">History</p>
                    <ul className="space-y-1">
                      {events.map((e, i) => (
                        <li key={i} className="text-xs text-un1t-subtle">
                          <span className="text-un1t-text">{e.kind === 'status' ? e.to_value : `${e.kind} ${e.from_value || '?'}→${e.to_value}`}</span>
                          {e.reason ? ` — ${e.reason}` : ''}
                          <span className="text-un1t-muted"> · {new Date(e.created_at).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {/* Name & Category */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
              <div>
                <label className="block text-sm mb-1.5">Template Name *</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. welcome_new_member"
                  disabled={(isSubmitted && !canResubmit)}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted disabled:opacity-50"
                />
                <p className="text-xs text-un1t-muted mt-1">Lowercase letters, numbers, and underscores only</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1.5">Category *</label>
                  <select
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    disabled={(isSubmitted && !canResubmit)}
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
                  >
                    {CATEGORIES.map(c => (
                      <option key={c.value} value={c.value}>{c.label} — {c.description}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Language</label>
                  <select
                    value={language}
                    onChange={e => setLanguage(e.target.value)}
                    disabled={(isSubmitted && !canResubmit)}
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
                  >
                    <option value="en">English</option>
                    <option value="en_US">English (US)</option>
                    <option value="en_GB">English (UK)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Header */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Header (optional)</h3>
              <select
                value={headerFormat}
                onChange={e => setHeaderFormat(e.target.value)}
                disabled={(isSubmitted && !canResubmit)}
                className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
              >
                {HEADER_FORMATS.map(h => (
                  <option key={h.value} value={h.value}>{h.label}</option>
                ))}
              </select>

              {headerFormat === 'TEXT' && (
                <input
                  type="text"
                  value={headerText}
                  onChange={e => setHeaderText(e.target.value)}
                  placeholder="Header text (max 60 chars)"
                  maxLength={60}
                  disabled={(isSubmitted && !canResubmit)}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted disabled:opacity-50"
                />
              )}

              {headerVars.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-un1t-subtle">Header sample value — shown to Meta for review.</p>
                  {headerVars.map((i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-un1t-muted w-10 shrink-0">{`{{${i}}}`}</span>
                      <input
                        type="text"
                        value={headerSamples[i] || ''}
                        onChange={e => setHeaderSamples(s => ({ ...s, [i]: e.target.value }))}
                        placeholder={`Example for {{${i}}}`}
                        disabled={(isSubmitted && !canResubmit)}
                        className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted disabled:opacity-50"
                      />
                    </div>
                  ))}
                </div>
              )}

              {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && (
                <div className="space-y-2">
                  <p className="text-xs text-un1t-muted">
                    Meta requires a real example asset for {headerFormat.toLowerCase()} headers — a placeholder URL gets the template rejected.
                    The file you upload here is BOTH submitted for approval AND used at send time as the default media.
                  </p>

                  {!mediaUrl ? (
                    <>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={MEDIA_LIMITS[headerFormat].accept}
                        onChange={handleMediaUpload}
                        disabled={(isSubmitted && !canResubmit) || uploading}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={(isSubmitted && !canResubmit) || uploading}
                        className="inline-flex items-center gap-2 text-sm bg-un1t-bg border border-un1t-border hover:border-un1t-muted text-un1t-text px-3 py-2 rounded-md transition-colors disabled:opacity-50"
                      >
                        <Upload size={14} />
                        {uploading ? 'Uploading…' : `Upload ${headerFormat.toLowerCase()}`}
                      </button>
                      <p className="text-[11px] text-un1t-muted">
                        Requirement: <span className="text-un1t-subtle">{MEDIA_LIMITS[headerFormat].label}</span>.
                        Same caps for every template category — Meta limits per file type, not per category.
                      </p>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 p-2.5 bg-un1t-bg border border-un1t-border rounded-md">
                      {headerFormat === 'IMAGE' && mediaUrl && (
                         
                        <img src={mediaUrl} alt="" className="w-10 h-10 object-cover rounded" />
                      )}
                      {headerFormat === 'VIDEO' && <Video size={20} className="text-un1t-subtle" />}
                      {headerFormat === 'DOCUMENT' && <FileText size={20} className="text-un1t-subtle" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-un1t-text truncate">
                          {mediaName || mediaPath?.split('/').pop() || 'Uploaded'}
                        </div>
                        <div className="text-[11px] text-un1t-muted truncate">
                          {mediaHandle ? 'Ready for Meta approval' : 'Uploaded — Meta handle missing, retry needed'}
                        </div>
                      </div>
                      {!(isSubmitted && !canResubmit) && (
                        <button
                          type="button"
                          onClick={clearMedia}
                          className="text-un1t-muted hover:text-red-400 p-1"
                          title="Remove and re-upload"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  )}

                  {uploadError && (
                    <p className="text-xs text-red-400">{uploadError}</p>
                  )}
                </div>
              )}
            </div>

            {/* Body */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Body *</h3>
              <textarea
                value={bodyText}
                onChange={e => setBodyText(e.target.value)}
                placeholder="Hello {{1}}, welcome to {{2}}! Your trial starts today."
                rows={5}
                maxLength={1024}
                disabled={(isSubmitted && !canResubmit)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted resize-y disabled:opacity-50"
              />
              <p className="text-xs text-un1t-muted">
                Use {'{{1}}'}, {'{{2}}'}, etc. for variables. Max 1024 characters.
                Variables will be mapped to contact fields when sending.
              </p>

              {bodyVars.length > 0 && (
                <div className="space-y-2 pt-1 border-t border-un1t-border">
                  <p className="text-xs text-un1t-subtle">Sample values — Meta reviews the template against these, so use realistic examples.</p>
                  {bodyVars.map((i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-un1t-muted w-10 shrink-0">{`{{${i}}}`}</span>
                      <input
                        type="text"
                        value={bodySamples[i] || ''}
                        onChange={e => setBodySamples(s => ({ ...s, [i]: e.target.value }))}
                        placeholder={`Example for {{${i}}}`}
                        disabled={(isSubmitted && !canResubmit)}
                        className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted disabled:opacity-50"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Footer (optional)</h3>
              <input
                type="text"
                value={footerText}
                onChange={e => setFooterText(e.target.value)}
                placeholder="e.g. Reply STOP to unsubscribe"
                maxLength={60}
                disabled={(isSubmitted && !canResubmit)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted disabled:opacity-50"
              />
            </div>

            {/* Buttons */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Buttons (optional, max 3)</h3>

              {buttons.map((btn, i) => (
                <div key={i} className="flex items-start gap-2 p-3 bg-un1t-surface rounded-lg border border-un1t-border">
                  <div className="flex-1 space-y-2">
                    <div className="flex gap-2">
                      <select
                        value={btn.type}
                        onChange={e => updateButton(i, { type: e.target.value })}
                        disabled={(isSubmitted && !canResubmit)}
                        className="bg-un1t-surface border border-un1t-border rounded-md px-2 py-1.5 text-xs text-un1t-text focus:outline-none disabled:opacity-50"
                      >
                        <option value="QUICK_REPLY">Quick Reply</option>
                        <option value="URL">URL</option>
                        <option value="PHONE_NUMBER">Phone Number</option>
                      </select>
                      <input
                        type="text"
                        value={btn.text}
                        onChange={e => updateButton(i, { text: e.target.value })}
                        placeholder="Button text"
                        maxLength={25}
                        disabled={(isSubmitted && !canResubmit)}
                        className="flex-1 bg-un1t-surface border border-un1t-border rounded-md px-2 py-1.5 text-xs text-un1t-text placeholder:text-un1t-muted focus:outline-none disabled:opacity-50"
                      />
                    </div>
                    {btn.type === 'URL' && (
                      <input
                        type="url"
                        value={btn.url || ''}
                        onChange={e => updateButton(i, { url: e.target.value })}
                        placeholder="https://..."
                        disabled={(isSubmitted && !canResubmit)}
                        className="w-full bg-un1t-surface border border-un1t-border rounded-md px-2 py-1.5 text-xs text-un1t-text placeholder:text-un1t-muted focus:outline-none disabled:opacity-50"
                      />
                    )}
                    {btn.type === 'PHONE_NUMBER' && (
                      <input
                        type="tel"
                        value={btn.phone_number || ''}
                        onChange={e => updateButton(i, { phone_number: e.target.value })}
                        placeholder="+353..."
                        disabled={(isSubmitted && !canResubmit)}
                        className="w-full bg-un1t-surface border border-un1t-border rounded-md px-2 py-1.5 text-xs text-un1t-text placeholder:text-un1t-muted focus:outline-none disabled:opacity-50"
                      />
                    )}
                  </div>
                  {!(isSubmitted && !canResubmit) && (
                    <button onClick={() => removeButton(i)} className="p-1 text-un1t-muted hover:text-red-400">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}

              {buttons.length < 3 && !(isSubmitted && !canResubmit) && (
                <div className="flex gap-2">
                  <button onClick={() => addButton('QUICK_REPLY')} className="text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border px-3 py-1.5 rounded-md transition-colors">
                    + Quick Reply
                  </button>
                  <button onClick={() => addButton('URL')} className="text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border px-3 py-1.5 rounded-md transition-colors">
                    + URL Button
                  </button>
                  <button onClick={() => addButton('PHONE_NUMBER')} className="text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border px-3 py-1.5 rounded-md transition-colors">
                    + Call Button
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right: Preview */}
          <div className="w-80 shrink-0">
            <div className="sticky top-6">
              <h3 className="text-sm font-semibold text-un1t-subtle mb-3">Preview</h3>
              <div className="bg-[#e5ddd5] rounded-lg p-4">
                <div className="bg-white rounded-lg p-3 shadow-sm max-w-[260px]">
                  {headerFormat === 'TEXT' && headerText && (
                    <p className="text-sm font-bold text-gray-900 mb-1">{headerText}</p>
                  )}
                  {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && (
                    <div className="bg-gray-200 rounded h-32 flex items-center justify-center text-gray-400 text-xs mb-2">
                      [{headerFormat}]
                    </div>
                  )}
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">
                    {bodyText || 'Your message body here...'}
                  </p>
                  {footerText && (
                    <p className="text-xs text-gray-500 mt-2">{footerText}</p>
                  )}
                  <p className="text-[10px] text-gray-400 text-right mt-1">12:00</p>
                </div>
                {buttons.length > 0 && (
                  <div className="mt-1 space-y-1 max-w-[260px]">
                    {buttons.map((btn, i) => (
                      <div key={i} className="bg-white rounded-lg py-2 text-center shadow-sm">
                        <span className="text-sm text-blue-500">{btn.text || 'Button'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
