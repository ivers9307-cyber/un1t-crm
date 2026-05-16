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
import { Check, AlertCircle, RotateCcw, Mail, ChevronDown } from 'lucide-react'
import { validateBcaConfig, DEFAULT_BCA_CONFIG, BCA_MERGE_TAGS } from '@/lib/bca'

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
    updateDoc(i, { label: DEFAULT_BCA_CONFIG.documents[i].label })
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
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-md p-3 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-sm rounded-md p-3 flex items-center gap-2">
          <Check size={14} /> Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <section className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <h3 className="text-sm font-semibold text-un1t-white mb-1 inline-flex items-center gap-1.5">
          <Mail size={14} /> Email
        </h3>
        <p className="text-xs text-un1t-light mb-4">
          The send-from address must be a Postmark-approved sender on this account.
          Add it under{' '}
          <a href="https://account.postmarkapp.com/signature_domains" target="_blank" rel="noopener noreferrer" className="underline hover:text-un1t-white">
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
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
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
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
            placeholder="vatclaims@bca.example"
          />
        </Field>

        <Field
          label="Subject template"
          hint={<>Supports merge vars: {BCA_MERGE_TAGS.map(t => <code key={t} className="text-[10px] mx-0.5 px-1 py-0.5 bg-un1t-gray/40 rounded">{'{{'}{t}{'}}'}</code>)}</>}
          error={fieldErrors.subject_template}
        >
          <input
            type="text"
            value={config.subject_template}
            onChange={e => update({ subject_template: e.target.value })}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
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
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
            placeholder={DEFAULT_BCA_CONFIG.body_template}
          />
        </Field>

        <button
          type="button"
          onClick={() => setShowPreview(p => !p)}
          className="mt-2 inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white"
        >
          <ChevronDown size={12} className={`transition-transform ${showPreview ? '' : '-rotate-90'}`} />
          {showPreview ? 'Hide' : 'Show'} preview with sample car
        </button>
        {showPreview && (
          <div className="mt-3 bg-un1t-black border border-un1t-gray rounded-md p-3 text-xs">
            <div className="text-un1t-mid mb-1">Subject</div>
            <div className="text-un1t-white font-mono mb-3">{renderedSubject}</div>
            <div className="text-un1t-mid mb-1">Body</div>
            <pre className="text-un1t-white whitespace-pre-wrap font-mono text-[11px]">{renderedBody}</pre>
            <p className="text-[10px] text-un1t-mid mt-3">
              Preview uses {sampleCar ? 'the most recent pending car at this location' : 'synthetic sample values'}.
            </p>
          </div>
        )}
      </section>

      <section className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <h3 className="text-sm font-semibold text-un1t-white mb-1">Document slots</h3>
        <p className="text-xs text-un1t-light mb-4">
          The 10 documents BCA requires for the UK VAT claim. Edit the labels to match BCA's
          checklist — slot keys (DOC_01…DOC_10) are managed by the system and shouldn't be changed.
        </p>
        {fieldErrors.documents && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-2 mb-3">
            {fieldErrors.documents}
          </div>
        )}
        <div className="space-y-2">
          {config.documents.map((d, i) => (
            <div key={d.slug} className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-un1t-mid w-14 shrink-0">{d.slug.toUpperCase()}</span>
              <input
                type="text"
                value={d.label}
                onChange={e => updateDoc(i, { label: e.target.value })}
                maxLength={80}
                className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-2.5 py-1.5 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                placeholder={DEFAULT_BCA_CONFIG.documents[i].label}
              />
              <button
                type="button"
                onClick={() => resetDoc(i)}
                title="Reset to placeholder label"
                className="text-un1t-light hover:text-un1t-white p-1"
              >
                <RotateCcw size={12} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
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
      <label className="block text-xs text-un1t-light mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-mid mt-1">{hint}</p>}
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
