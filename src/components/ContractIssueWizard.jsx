'use client'

// Issue-a-contract wizard. Three steps:
//   1. Pick a recipient + a template (employment_type-filtered).
//   2. Fill custom variables declared in the template's
//      variables_schema (built-in profile auto-fills are merged
//      automatically server-side; we only need the issuer to
//      provide the dynamic ones).
//   3. Preview the rendered body, type the issuer's countersign
//      name, and click Issue.
//
// Recipient list is fetched from /api/staff. Templates from
// /api/contract-templates.

import { useState, useEffect, useMemo, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, FileText, AlertCircle } from 'lucide-react'
import { renderTemplate, profileVariables, unresolvedPlaceholders } from '@/lib/contracts'
import ContractBody from '@/components/ContractBody'

export default function ContractIssueWizard({ issuerName }) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [staff, setStaff] = useState([])
  const [templates, setTemplates] = useState([])
  const [profileId, setProfileId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [vars, setVars] = useState({})
  const [issuerSig, setIssuerSig] = useState(issuerName || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    Promise.all([
      fetch('/api/staff').then(r => r.json()),
      fetch('/api/contract-templates').then(r => r.json()),
    ])
      .then(([staffRes, tplRes]) => {
        if (!active) return
        setStaff(staffRes?.data || staffRes?.staff || [])
        setTemplates((tplRes?.data || []).filter(t => t.active))
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const recipient = useMemo(
    () => staff.find(s => s.id === profileId) || null,
    [staff, profileId],
  )
  const template = useMemo(
    () => templates.find(t => t.id === templateId) || null,
    [templates, templateId],
  )
  const eligibleTemplates = useMemo(() => {
    if (!recipient) return templates
    return templates.filter(
      t => t.employment_type === 'both' || t.employment_type === recipient.employment_type,
    )
  }, [templates, recipient])

  const customVarDefs = useMemo(
    () => template?.variables_schema || [],
    [template],
  )
  const declaredKeys = useMemo(
    () => new Set(customVarDefs.map((v) => v.key)),
    [customVarDefs],
  )

  // CONTRACT-VARS.1 — placeholders in the body that are NEITHER
  // auto-fillable from the profile NOR declared in variables_schema.
  // Recomputed whenever the issuer fills more values so the list
  // shortens as they go. The wizard surfaces these as their own
  // input section so an issuer can't accidentally send a contract
  // with `{{notice_period}}` literally in the text.
  const unmappedKeys = useMemo(() => {
    if (!template || !recipient) return []
    // Compute against an EMPTY variables object so we get every
    // unfilled-and-undeclared placeholder, including the ones the
    // issuer is currently typing into. Then subtract declared keys
    // (those have their own field) — what's left is "this template
    // references {{foo}} but {{foo}} isn't declared anywhere".
    const undeclared = unresolvedPlaceholders(template.body_markdown, recipient, {})
      .filter((k) => !declaredKeys.has(k))
    return undeclared
  }, [template, recipient, declaredKeys])

  // Live preview using merged variables for step 3.
  const preview = useMemo(() => {
    if (!template || !recipient) return ''
    const merged = { ...profileVariables(recipient), ...vars }
    return renderTemplate(template.body_markdown, merged)
  }, [template, recipient, vars])

  // Placeholders that would render literally given current values.
  // Drives both the "still missing" warning + the visual highlight
  // in the preview.
  const stillUnfilled = useMemo(() => {
    if (!template || !recipient) return []
    return unresolvedPlaceholders(template.body_markdown, recipient, vars)
  }, [template, recipient, vars])

  function setVar(key, val) {
    setVars(v => ({ ...v, [key]: val }))
  }

  function canAdvanceStep1() {
    return profileId && templateId
  }

  function canAdvanceStep2() {
    for (const v of customVarDefs) {
      if (v.required && !vars[v.key]) return false
    }
    // CONTRACT-VARS.1 — every unmapped key must also be filled
    // before advancing. Treats empty string + whitespace-only as
    // unfilled.
    for (const k of unmappedKeys) {
      const v = vars[k]
      if (v == null || String(v).trim() === '') return false
    }
    return true
  }

  async function handleIssue() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: templateId,
          profile_id: profileId,
          variables: vars,
          issuer_signature: issuerSig,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      router.push(`/admin/contracts/${json.data.id}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
      <StepHeader step={step} />

      {step === 1 && (
        <div className="space-y-4 mt-5">
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Recipient</label>
            <select
              value={profileId}
              onChange={e => { setProfileId(e.target.value); setTemplateId('') }}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm"
            >
              <option value="">Pick a staff member…</option>
              {staff.map(s => (
                <option key={s.id} value={s.id}>
                  {s.full_name} · {s.email} · {s.employment_type || 'unknown'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Template</label>
            <select
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              disabled={!profileId}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm disabled:opacity-50"
            >
              <option value="">{profileId ? 'Pick a template…' : 'Pick a recipient first'}</option>
              {eligibleTemplates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} (v{t.version})
                </option>
              ))}
            </select>
            {recipient && eligibleTemplates.length === 0 && (
              <p className="text-xs text-amber-700 mt-1">
                No active templates match this recipient&apos;s employment type
                ({recipient.employment_type || 'unknown'}). Create one first.
              </p>
            )}
          </div>
          <div className="flex justify-end pt-2">
            <button
              type="button"
              disabled={!canAdvanceStep1()}
              onClick={() => setStep(2)}
              className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >Next <ChevronRight size={11} /></button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4 mt-5">
          <p className="text-xs text-un1t-subtle">
            Profile fields ({recipient?.full_name}, {recipient?.email}, role, salary etc.) are
            auto-filled from the recipient&apos;s record. Just supply any custom variables this
            template needs.
          </p>
          {customVarDefs.length === 0 && unmappedKeys.length === 0 ? (
            <p className="text-xs text-un1t-muted italic">
              This template has no custom variables. Click Next to preview &amp; issue.
            </p>
          ) : (
            <>
              {customVarDefs.length > 0 && (
                <div className="space-y-3">
                  {customVarDefs.map(v => (
                    <div key={v.key}>
                      <label className="block text-sm text-un1t-subtle mb-1">
                        {v.label}
                        {v.required && <span className="text-red-700"> *</span>}
                        <code className="ml-2 text-[10px] text-un1t-muted">{`{{${v.key}}}`}</code>
                      </label>
                      <input
                        type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'}
                        required={v.required}
                        value={vars[v.key] ?? ''}
                        onChange={e => setVar(v.key, e.target.value)}
                        className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm"
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* CONTRACT-VARS.1 — placeholders in the template body
                  that aren't declared in variables_schema. Surface them
                  as required inputs so the issuer fills values before
                  the contract goes out. The right long-term fix is to
                  add the key to the template's variables_schema, but
                  the per-contract override here means a bad template
                  doesn't block a real send. */}
              {unmappedKeys.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 mt-4">
                  <div className="flex items-start gap-2 mb-2">
                    <AlertCircle size={14} className="text-amber-700 mt-0.5 shrink-0" />
                    <div className="text-xs text-amber-700">
                      <div className="font-semibold">
                        {unmappedKeys.length === 1
                          ? 'One variable in this template isn\'t auto-filled or declared.'
                          : `${unmappedKeys.length} variables in this template aren't auto-filled or declared.`}
                      </div>
                      <div className="mt-0.5">
                        Fill values here so they don’t appear literally in the issued
                        contract. For long-term hygiene, add them to the template’s
                        custom-variables list.
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3 mt-3">
                    {unmappedKeys.map((k) => (
                      <div key={k}>
                        <label className="block text-sm text-un1t-subtle mb-1">
                          {k.replace(/_/g, ' ')}
                          <span className="text-red-700"> *</span>
                          <code className="ml-2 text-[10px] text-un1t-muted">{`{{${k}}}`}</code>
                        </label>
                        <input
                          type="text"
                          required
                          value={vars[k] ?? ''}
                          onChange={(e) => setVar(k, e.target.value)}
                          className="w-full bg-un1t-bg border border-amber-500/40 rounded-md px-3 py-2 text-sm"
                          placeholder={`Value for ${k}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
            >← Back</button>
            <button
              type="button"
              disabled={!canAdvanceStep2()}
              onClick={() => setStep(3)}
              className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >Next <ChevronRight size={11} /></button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4 mt-5">
          {stillUnfilled.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 flex items-start gap-2">
              <AlertCircle size={14} className="text-amber-700 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-700">
                <div className="font-semibold">
                  {stillUnfilled.length === 1
                    ? 'One placeholder still has no value.'
                    : `${stillUnfilled.length} placeholders still have no value.`}
                </div>
                <div className="mt-0.5">
                  Go back and fill: {stillUnfilled.map((k) => (
                    <Fragment key={k}>
                      <code className="bg-amber-500/15 text-amber-800 rounded px-1 mr-1">{`{{${k}}}`}</code>
                    </Fragment>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Preview</label>
            {stillUnfilled.length > 0 ? (
              // Raw view — while placeholders are still unresolved we
              // show the literal markdown source with each unfilled
              // {{placeholder}} highlighted, so the issuer can see
              // exactly where they'll appear in the final document.
              // Rendering this through ContractBody would hide the
              // literal {{...}} runs inside markdown formatting, so
              // the raw view stays plain text until everything resolves.
              <div className="bg-white text-gray-900 border border-un1t-border rounded-md p-4 max-h-[400px] overflow-auto whitespace-pre-wrap text-sm leading-relaxed">
                {renderPreviewWithHighlights(preview)}
              </div>
            ) : (
              <div className="bg-white text-gray-900 border border-un1t-border rounded-md p-4 max-h-[400px] overflow-auto">
                <ContractBody markdown={preview} />
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">
              Your countersignature <span className="text-red-700">*</span>
            </label>
            <input
              type="text"
              required
              value={issuerSig}
              onChange={e => setIssuerSig(e.target.value)}
              placeholder="Type your full name to countersign"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-serif text-base"
            />
            <p className="text-[11px] text-un1t-muted mt-1">
              The recipient will see this name on their contract as the employer signature, alongside their own when they sign.
            </p>
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
            >← Back</button>
            <button
              type="button"
              disabled={!issuerSig || busy || stillUnfilled.length > 0}
              onClick={handleIssue}
              title={
                stillUnfilled.length > 0
                  ? `Fill ${stillUnfilled.length} remaining placeholder${stillUnfilled.length === 1 ? '' : 's'} before issuing.`
                  : undefined
              }
              className="text-xs bg-un1t-text text-un1t-bg px-4 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >
              <FileText size={11} /> {busy ? 'Issuing…' : 'Issue contract'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Splits the preview text into runs and wraps any literal {{...}}
// placeholder in a yellow-highlighted span so the issuer can see
// exactly where unfilled values would appear in the final document.
// Returns an array of strings + <mark> elements ready for React.
function renderPreviewWithHighlights(text) {
  if (!text) return text
  const re = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g
  const parts = []
  let last = 0
  let m
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <mark key={`m${i++}`} className="bg-amber-300 text-amber-900 rounded px-0.5">{m[0]}</mark>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function StepHeader({ step }) {
  const steps = [
    { n: 1, label: 'Recipient & template' },
    { n: 2, label: 'Variables' },
    { n: 3, label: 'Preview & issue' },
  ]
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <li key={s.n} className="flex items-center gap-2">
          <span className={`w-6 h-6 rounded-full flex items-center justify-center font-semibold ${
            step === s.n ? 'bg-un1t-text text-un1t-bg'
              : step > s.n ? 'bg-emerald-500/20 text-emerald-700'
              : 'bg-un1t-border text-un1t-subtle'
          }`}>{s.n}</span>
          <span className={step === s.n ? 'text-un1t-text font-medium' : 'text-un1t-subtle'}>{s.label}</span>
          {i < steps.length - 1 && <span className="text-un1t-muted">→</span>}
        </li>
      ))}
    </ol>
  )
}
