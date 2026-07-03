'use client'

// Per-location BCA Submit configuration editor.
// Master-only. Lives at /settings/locations/[id]/bca.
//
// Edits: send-from address, send-to address, subject template, body
// template, the 10 doc slot labels. Slugs (doc_01..doc_10) are stable
// — operator never edits them, but they're displayed as small badges
// so renames / reorders in the UI are unambiguous about which slot is
// which.
//
// Saves via PUT /api/locations/[id]/bca-config which runs the same
// validateBcaConfig() this component does, so a payload that passes
// client-side always passes server-side too.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, AlertCircle, RotateCcw, Mail, ChevronDown, Plus, X } from 'lucide-react'
import {
  validateBcaConfig,
  DEFAULT_BCA_CONFIG,
  DEFAULT_BCA_DOCUMENTS,
  BCA_MERGE_TAGS,
  MIN_BCA_DOCUMENTS,
  MAX_BCA_DOCUMENTS,
  nextBcaSlotSlug,
} from '@/lib/bca'

export default function BcaSubmitSettings({ location, initialConfig, sampleCar }) {
  const router = useRouter()
  const [config, setConfig] = useState(initialConfig)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})
  const [savedAt, setSavedAt] = useState(null)
  const [showPreview, setShowPreview] = useState(true)

  function update(patch) {
    setConfig(c => ({ ...c, ...patch }))
    // Clear field errors as soon as the operator touches anything.
    if (Object.keys(fieldErrors).length) setFieldErrors({})
  }
  function updateDoc(i, patch) {
    setConfig(c => ({
      ...c,
      documents: c.documents.map((d, idx) => idx === i ? { ...d, ...patch } : d),
    }))
    if (fieldErrors.documents) setFieldErrors(fe => ({ ...fe, documents: undefined }))
  }
  function resetDoc(i) {
    // For positions beyond the default-10, fall back to a generic
    // "Document N (placeholder)" label.
    const fallback = DEFAULT_BCA_CONFIG.documents[i]?.label || `Document ${i + 1} (placeholder)`
    updateDoc(i, { label: fallback })
  }
  function addDoc() {
    setConfig(c => {
      if (c.documents.length >= MAX_BCA_DOCUMENTS) return c
      const slug = nextBcaSlotSlug(c.documents)
      if (!slug) return c
      // Default label numbered by the new slot's position, not its
      // slug — operator-friendly when there are gaps in the slug
      // sequence ("Document 4" reads better than the slug suggests).
      const label = `Document ${c.documents.length + 1} (placeholder)`
      return { ...c, documents: [...c.documents, { slug, label }] }
    })
    if (fieldErrors.documents) setFieldErrors(fe => ({ ...fe, documents: undefined }))
  }
  function removeDoc(i) {
    if (config.documents.length <= MIN_BCA_DOCUMENTS) return
    const doc = config.documents[i]
    if (!confirm(
      `Remove slot ${i + 1} (${doc.label})?\n\n` +
      `If any file is currently staged in this slot on a car, it'll stay in storage but won't ` +
      `be visible — re-adding the slot later (same slug ${doc.slug.toUpperCase()}) brings it back.`
    )) return
    setConfig(c => ({ ...c, documents: c.documents.filter((_, idx) => idx !== i) }))
    if (fieldErrors.documents) setFieldErrors(fe => ({ ...fe, documents: undefined }))
  }

  async function save() {
    setBusy(true); setError(null); setFieldErrors({}); setSavedAt(null)
    // Run the same validator the server runs, locally first, for
    // immediate field-level feedback.
    const v = validateBcaConfig(config)
    if (!v.ok) {
      setFieldErrors(v.errors)
      setError('Please fix the highlighted fields.')
      setBusy(false)
      return
    }
    try {
      const r = await fetch(`/api/locations/${location.id}/bca-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v.value),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        if (j.errors) setFieldErrors(j.errors)
        setError(j.error || `Save failed (${r.status})`)
        setBusy(false)
        return
      }
      setConfig(j.data.config)
      setSavedAt(new Date())
      router.refresh()
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  // Render-time merge preview for subject + body. Uses a sample car
  // (most recent pending at this location, server-passed) or fallback
  // synthetic values if no real one exists yet.
  const previewCar = sampleCar || {
    uk_reg: 'AB12 XYZ', irish_reg: '241-D-12345', vin: 'WBA1234567890',
    make: 'Tesla', model: 'Model 3', vehicle_year: 2023,
    buyer_name: 'Sample Buyer', buyer_email: 'buyer@example.com',
    xero_invoice_number: 'INV-0042',
  }
  const renderedSubject = renderPreview(config.subject_template, previewCar)
  const renderedBody = renderPreview(config.body_template, previewCar)

  return (
    <div className="space-y-5 max-w-2xl">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-sm rounded-md p-3 flex items-center gap-2">
          <Check size={14} /> Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <section className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
        <h3 className="text-sm font-semibold text-un1t-text mb-1 inline-flex items-center gap-1.5">
          <Mail size={14} /> Email
        </h3>
        <p className="text-xs text-un1t-subtle mb-4">
          The send-from address must be a Postmark-approved sender on this account.
          Add it under{' '}
          <a href="https://account.postmarkapp.com/signature_domains" target="_blank" rel="noopener noreferrer" className="underline hover:text-un1t-text">
            Postmark → Sender Signatures
          </a>{' '}
          first, otherwise the submit endpoint will refuse with a 422.
        </p>

        <Field
          label="Send from"
          hint="Branded address like vat-claims@ccfautos.com. Must be approved in Postmark."
          error={fieldErrors.send_from}
        >
          <input
            type="email"
            value={config.send_from}
            onChange={e => update({ send_from: e.target.value })}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="vat-claims@ccfautos.com"
          />
        </Field>

        <Field
          label="Send to (BCA recipient)"
          hint="BCA's claims address. Confirm with the operator before saving."
          error={fieldErrors.send_to}
        >
          <input
            type="email"
            value={config.send_to}
            onChange={e => update({ send_to: e.target.value })}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="vatclaims@bca.example"
          />
        </Field>

        <Field
          label="CC (optional)"
          hint="Use this when the send-from address is a Postmark send-only sender (no inbox). The CC lands in a mailbox you actually monitor so you can confirm BCA received the pack. Leave blank for no CC."
          error={fieldErrors.cc}
        >
          <input
            type="email"
            value={config.cc || ''}
            onChange={e => update({ cc: e.target.value })}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="ops@ccfautos.com"
          />
        </Field>

        <Field
          label="Subject template"
          hint={<>Supports merge vars: {BCA_MERGE_TAGS.map(t => <code key={t} className="text-[10px] mx-0.5 px-1 py-0.5 bg-un1t-border/40 rounded">{'{{'}{t}{'}}'}</code>)}</>}
          error={fieldErrors.subject_template}
        >
          <input
            type="text"
            value={config.subject_template}
            onChange={e => update({ subject_template: e.target.value })}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted font-mono"
            placeholder={DEFAULT_BCA_CONFIG.subject_template}
          />
        </Field>

        <Field
          label="Body template"
          hint="Plain text. Same merge vars as the subject."
          error={fieldErrors.body_template}
        >
          <textarea
            value={config.body_template}
            onChange={e => update({ body_template: e.target.value })}
            rows={8}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted font-mono"
            placeholder={DEFAULT_BCA_CONFIG.body_template}
          />
        </Field>

        <button
          type="button"
          onClick={() => setShowPreview(p => !p)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text"
        >
          <ChevronDown size={12} className={`transition-transform ${showPreview ? '' : '-rotate-90'}`} />
          {showPreview ? 'Hide' : 'Show'} preview with sample car
        </button>
        {showPreview && (
          <div className="mt-3 bg-un1t-bg border border-un1t-border rounded-md p-3 text-xs">
            <div className="text-un1t-muted mb-1">Subject</div>
            <div className="text-un1t-text font-mono mb-3">{renderedSubject}</div>
            <div className="text-un1t-muted mb-1">Body</div>
            <pre className="text-un1t-text whitespace-pre-wrap font-mono text-[11px]">{renderedBody}</pre>
            <p className="text-[10px] text-un1t-muted mt-3">
              Preview uses {sampleCar ? 'the most recent pending car at this location' : 'synthetic sample values'}.
            </p>
          </div>
        )}
      </section>

      <section className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
        <h3 className="text-sm font-semibold text-un1t-text mb-1">Document slots</h3>
        <p className="text-xs text-un1t-subtle mb-4">
          The documents BCA requires for the UK VAT claim. Edit labels to match BCA's checklist;
          add or remove slots if their requirements change. Slot keys (DOC_01…) are managed by
          the system and stable across renames — a removed slot re-added later keeps the same key.
          Currently {config.documents.length} slot{config.documents.length === 1 ? '' : 's'}
          (min {MIN_BCA_DOCUMENTS}, max {MAX_BCA_DOCUMENTS}).
        </p>
        {fieldErrors.documents && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 mb-3">
            {fieldErrors.documents}
          </div>
        )}
        <div className="space-y-2">
          {config.documents.map((d, i) => (
            <div key={d.slug} className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-un1t-muted w-14 shrink-0">{d.slug.toUpperCase()}</span>
              <input
                type="text"
                value={d.label}
                onChange={e => updateDoc(i, { label: e.target.value })}
                maxLength={80}
                className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                placeholder={DEFAULT_BCA_DOCUMENTS[i]?.label || `Document ${i + 1} (placeholder)`}
              />
              <button
                type="button"
                onClick={() => resetDoc(i)}
                title="Reset to placeholder label"
                className="text-un1t-subtle hover:text-un1t-text p-1"
              >
                <RotateCcw size={12} />
              </button>
              <button
                type="button"
                onClick={() => removeDoc(i)}
                disabled={config.documents.length <= MIN_BCA_DOCUMENTS}
                title={config.documents.length <= MIN_BCA_DOCUMENTS
                  ? `Can't remove — at least ${MIN_BCA_DOCUMENTS} slot required.`
                  : 'Remove this slot'}
                className="text-un1t-subtle hover:text-red-400 p-1 disabled:opacity-30 disabled:hover:text-un1t-subtle disabled:cursor-not-allowed"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-un1t-border/40 flex items-center justify-between">
          <button
            type="button"
            onClick={addDoc}
            disabled={config.documents.length >= MAX_BCA_DOCUMENTS}
            className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1 rounded border border-un1t-border hover:border-un1t-subtle disabled:opacity-40 disabled:hover:text-un1t-subtle disabled:cursor-not-allowed"
          >
            <Plus size={11} /> Add document slot
          </button>
          {config.documents.length >= MAX_BCA_DOCUMENTS && (
            <span className="text-[11px] text-un1t-muted">Maximum {MAX_BCA_DOCUMENTS} reached.</span>
          )}
        </div>
      </section>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// Tiny field wrapper — label, hint, child, optional error message.
function Field({ label, hint, error, children }) {
  return (
    <div className="mb-3">
      <label className="block text-xs text-un1t-subtle mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-muted mt-1">{hint}</p>}
      {error && (
        <p className="text-[11px] text-red-400 mt-1 inline-flex items-center gap-1">
          <AlertCircle size={10} /> {error}
        </p>
      )}
    </div>
  )
}

// Client-side preview renderer — duplicates renderBcaTemplate from
// src/lib/bca.js so we don't bundle the entire lib (and the validator)
// twice. Tiny and lockstep with the server-side renderer.
function renderPreview(tmpl, car) {
  if (typeof tmpl !== 'string') return ''
  return tmpl.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!BCA_MERGE_TAGS.includes(k)) return m
    const v = car?.[k]
    return v == null ? '' : String(v)
  })
}
