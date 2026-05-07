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

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, FileText } from 'lucide-react'
import { renderTemplate, profileVariables } from '@/lib/contracts'

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

  const customVarDefs = template?.variables_schema || []

  // Live preview using merged variables for step 3.
  const preview = useMemo(() => {
    if (!template || !recipient) return ''
    const merged = { ...profileVariables(recipient), ...vars }
    return renderTemplate(template.body_markdown, merged)
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
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
      <StepHeader step={step} />

      {step === 1 && (
        <div className="space-y-4 mt-5">
          <div>
            <label className="block text-sm text-un1t-light mb-1">Recipient</label>
            <select
              value={profileId}
              onChange={e => { setProfileId(e.target.value); setTemplateId('') }}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm"
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
            <label className="block text-sm text-un1t-light mb-1">Template</label>
            <select
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              disabled={!profileId}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm disabled:opacity-50"
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
              className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >Next <ChevronRight size={11} /></button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4 mt-5">
          <p className="text-xs text-un1t-light">
            Profile fields ({recipient?.full_name}, {recipient?.email}, role, salary etc.) are
            auto-filled from the recipient&apos;s record. Just supply any custom variables this
            template needs.
          </p>
          {customVarDefs.length === 0 ? (
            <p className="text-xs text-un1t-mid italic">
              This template has no custom variables. Click Next to preview &amp; issue.
            </p>
          ) : (
            <div className="space-y-3">
              {customVarDefs.map(v => (
                <div key={v.key}>
                  <label className="block text-sm text-un1t-light mb-1">
                    {v.label}
                    {v.required && <span className="text-red-700"> *</span>}
                    <code className="ml-2 text-[10px] text-un1t-mid">{`{{${v.key}}}`}</code>
                  </label>
                  <input
                    type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'}
                    required={v.required}
                    value={vars[v.key] ?? ''}
                    onChange={e => setVar(v.key, e.target.value)}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm"
                  />
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white"
            >← Back</button>
            <button
              type="button"
              disabled={!canAdvanceStep2()}
              onClick={() => setStep(3)}
              className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >Next <ChevronRight size={11} /></button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4 mt-5">
          <div>
            <label className="block text-sm text-un1t-light mb-1">Preview</label>
            <div className="bg-white text-gray-900 border border-un1t-gray rounded-md p-4 max-h-[400px] overflow-auto whitespace-pre-wrap text-sm leading-relaxed">
              {preview}
            </div>
          </div>
          <div>
            <label className="block text-sm text-un1t-light mb-1">
              Your countersignature <span className="text-red-700">*</span>
            </label>
            <input
              type="text"
              required
              value={issuerSig}
              onChange={e => setIssuerSig(e.target.value)}
              placeholder="Type your full name to countersign"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-serif text-base"
            />
            <p className="text-[11px] text-un1t-mid mt-1">
              The recipient will see this name on their contract as the employer signature, alongside their own when they sign.
            </p>
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white"
            >← Back</button>
            <button
              type="button"
              disabled={!issuerSig || busy}
              onClick={handleIssue}
              className="text-xs bg-un1t-white text-un1t-black px-4 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
            >
              <FileText size={11} /> {busy ? 'Issuing…' : 'Issue contract'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
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
            step === s.n ? 'bg-un1t-white text-un1t-black'
              : step > s.n ? 'bg-emerald-500/20 text-emerald-700'
              : 'bg-un1t-gray text-un1t-light'
          }`}>{s.n}</span>
          <span className={step === s.n ? 'text-un1t-white font-medium' : 'text-un1t-light'}>{s.label}</span>
          {i < steps.length - 1 && <span className="text-un1t-mid">→</span>}
        </li>
      ))}
    </ol>
  )
}
