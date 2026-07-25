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

import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight, FileText, AlertCircle, Info } from 'lucide-react'
import { renderTemplate, profileVariables, unresolvedPlaceholders, extractPlaceholders, customVariablesFrom, LOCATION_VAR_KEYS } from '@/lib/contracts'
import ContractBody from '@/components/ContractBody'

// CONTRACTS-VARS.2 — the wizard has no way to know the recipient's
// location fields client-side (they're resolved server-side at issue
// time from the recipient's location + getLocationBranding() — see
// locationVariables() in /api/contracts). Bracket placeholders here
// stand in for the real values so the preview shows the issuer WHERE
// they'll land in the final document, and LOCATION_VAR_KEYS is passed
// as unresolvedPlaceholders()'s assumeKeys so these never show up as
// "still needs a value" prompts.
const LOCATION_VAR_PREVIEW = {
  location_name: '[location name]',
  location_address: '[location address]',
  location_phone: '[location phone]',
  location_email: '[location email]',
  company_name: '[company name]',
}

export default function ContractIssueWizard({ issuerName, fromContractId }) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [staff, setStaff] = useState([])
  const [templates, setTemplates] = useState([])
  const [profileId, setProfileId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [vars, setVars] = useState({})
  const [issuerSig, setIssuerSig] = useState(issuerName || '')
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState(null) // 'issue' | 'draft' | null
  const [error, setError] = useState(null)

  // CONTRACTS-DRAFT.1 — re-issue prefill. ?from=<contractId> is
  // passed down from the host page; on mount we fetch that contract
  // (owner/master GET — same route the detail page uses) and prefill
  // recipient + template + custom variables from it. The rendered
  // BODY is never prefilled — a hand-edited body only ever comes from
  // the B1 editor on THIS issue, never carried forward.
  const [prefillNote, setPrefillNote] = useState(false)

  // CONTRACTS-VARS.2 — holds the re-issue prefill's custom variables
  // between the moment the /api/contracts/[id] fetch resolves and the
  // moment `template` itself resolves (the two fetches — staff+templates
  // vs. the prefill contract — run in parallel, so whichever finishes
  // last is what actually unblocks the defaults-seeding effect below).
  // Consumed (nulled) the first time it's read so a later manual
  // template switch doesn't keep re-applying a stale prefill.
  const pendingPrefillVarsRef = useRef(null)

  // CONTRACTS-EDIT.1 — per-contract body edit at step 3. null means
  // "untouched" (issue with the plain rendered preview); once set it
  // holds the issuer's hand-edited text and is what actually gets
  // issued. editingBody toggles the textarea; editPreviewMode only
  // matters while editingBody is true (Formatted renders bodyOverride
  // through ContractBody, Raw shows the literal source with any
  // remaining {{placeholder}} highlighted).
  const [bodyOverride, setBodyOverride] = useState(null)
  const [editingBody, setEditingBody] = useState(false)
  const [editPreviewMode, setEditPreviewMode] = useState('formatted')

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

  useEffect(() => {
    if (!fromContractId) return
    let active = true
    fetch(`/api/contracts/${fromContractId}`)
      .then(r => r.json())
      .then(json => {
        if (!active || !json?.success || !json.data) return
        const c = json.data
        if (c.profile_id) setProfileId(c.profile_id)
        if (c.template_id) setTemplateId(c.template_id)
        // CONTRACTS-VARS.2 — stash for the defaults-seeding effect below
        // instead of setting vars directly here: that effect knows how
        // to merge "prefill wins over default" once `template` resolves,
        // which may happen after this fetch (see the ref's doc comment).
        pendingPrefillVarsRef.current = customVariablesFrom(c.variables_data, c.profile)
        setPrefillNote(true)
      })
      .catch(() => {
        // A failed prefill just leaves the wizard blank — the issuer
        // can still fill everything in manually.
      })
    return () => { active = false }
  }, [fromContractId])

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

  // CONTRACTS-VARS.2 — (re)seed `vars` whenever the SELECTED TEMPLATE
  // actually changes (not on every render — `template` is a stable
  // reference from the `templates` array as long as templateId/templates
  // haven't changed). Precedence: per-key template default < re-issue
  // prefill (consumed once from the ref above, if one is pending) —
  // issuer typing wins over both simply because nothing runs this
  // effect again until templateId changes, so a later setVar() call is
  // never clobbered. Switching to a genuinely different template (no
  // pending prefill) resets to just that template's defaults — old
  // values typed for the previous template don't leak across.
  useEffect(() => {
    if (!template) {
      setVars({})
      return
    }
    const defaults = {}
    for (const row of customVarDefs) {
      if (row.default != null && row.default !== '') defaults[row.key] = row.default
    }
    const prefillVars = pendingPrefillVarsRef.current
    pendingPrefillVarsRef.current = null
    setVars({ ...defaults, ...(prefillVars || {}) })
  }, [template, customVarDefs])

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
    // CONTRACTS-VARS.2 — location vars are auto-filled server-side, so
    // they never belong in this "still needs a value" list even though
    // the wizard has no way to resolve them itself.
    const undeclared = unresolvedPlaceholders(template.body_markdown, recipient, {}, { assumeKeys: LOCATION_VAR_KEYS })
      .filter((k) => !declaredKeys.has(k))
    return undeclared
  }, [template, recipient, declaredKeys])

  // CONTRACTS-VARS.2 — does this template reference any location var?
  // Gates the "filled in automatically" hint and the override warning
  // below so they only show up when relevant.
  const templateUsesLocationVars = useMemo(() => {
    if (!template) return false
    return extractPlaceholders(template.body_markdown).some((k) => LOCATION_VAR_KEYS.includes(k))
  }, [template])

  // Live preview using merged variables for step 3. Location vars get
  // a bracketed stand-in ([location name] etc.) rather than a real
  // value — the wizard can't resolve them client-side; see the module
  // doc comment on LOCATION_VAR_PREVIEW.
  const preview = useMemo(() => {
    if (!template || !recipient) return ''
    const merged = { ...profileVariables(recipient), ...LOCATION_VAR_PREVIEW, ...vars }
    return renderTemplate(template.body_markdown, merged)
  }, [template, recipient, vars])

  // Placeholders that would render literally given current values.
  // Drives both the "still missing" warning + the visual highlight
  // in the preview.
  const stillUnfilled = useMemo(() => {
    if (!template || !recipient) return []
    return unresolvedPlaceholders(template.body_markdown, recipient, vars, { assumeKeys: LOCATION_VAR_KEYS })
  }, [template, recipient, vars])

  // CONTRACTS-EDIT.1 — once the issuer hand-edits the body, the
  // "still unresolved" check moves from the template-render
  // placeholders to whatever's literally still in the edited text
  // (the override is the final text — there's no further variable
  // merge to reason about).
  const overrideUnresolvedKeys = useMemo(() => {
    if (bodyOverride == null) return []
    return extractPlaceholders(bodyOverride)
  }, [bodyOverride])
  const effectiveUnresolved = bodyOverride != null ? overrideUnresolvedKeys : stillUnfilled
  const effectiveBody = bodyOverride != null ? bodyOverride : preview

  function setVar(key, val) {
    setVars(v => ({ ...v, [key]: val }))
  }

  // Shared by both "← Back" buttons (step2→1 and step3→2). A
  // non-null override means the issuer has hand-edited the body —
  // changing recipient/template/variables invalidates those edits,
  // so confirm before silently discarding them.
  function goBack(targetStep) {
    if (bodyOverride != null) {
      const ok = window.confirm(
        'Going back will discard your manual edits to the contract text. Continue?'
      )
      if (!ok) return
      setBodyOverride(null)
      setEditingBody(false)
    }
    setStep(targetStep)
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

  // CONTRACTS-DRAFT.1 — shared submit for both "Issue contract" and
  // "Save as draft"; the only difference is save_as_draft in the
  // payload (and there's never a warning to stash for a draft — the
  // server never attempts an email/push for one).
  async function handleIssue(asDraft = false) {
    setBusy(true)
    setPendingAction(asDraft ? 'draft' : 'issue')
    setError(null)
    try {
      const payload = {
        template_id: templateId,
        profile_id: profileId,
        variables: vars,
        issuer_signature: issuerSig,
      }
      // Only send an override when it's actually a hand-edit — a
      // toggled-on-then-untouched textarea equals the plain rendered
      // preview and shouldn't count as an edit server-side.
      if (bodyOverride != null && bodyOverride !== preview) {
        payload.body_override = bodyOverride
      }
      if (asDraft) payload.save_as_draft = true
      const res = await fetch('/api/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      // CONTRACTS-EDIT.1 — handleIssue used to read json.warning (e.g.
      // "email could not be sent") and drop it on the floor before
      // navigating away. Stash it for the detail page's
      // ContractIssueWarningBanner to pick up on mount.
      if (json.warning) {
        try {
          window.sessionStorage.setItem(`contract-issue-warning:${json.data.id}`, json.warning)
        } catch {
          // Private-browsing storage block — the warning just won't
          // surface on the detail page; the issue itself still went
          // through fine.
        }
      }
      router.push(`/admin/contracts/${json.data.id}`)
      router.refresh()
    } catch (e) {
      setError(e.message)
      setBusy(false)
      setPendingAction(null)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
      <StepHeader step={step} />

      {prefillNote && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-md p-3 mt-4 flex items-start gap-2">
          <Info size={14} className="text-blue-700 mt-0.5 shrink-0" />
          <p className="text-xs text-blue-700">
            Details restored from the previous contract. Review before issuing.
          </p>
        </div>
      )}

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
              onClick={() => goBack(1)}
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
          {effectiveUnresolved.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 flex items-start gap-2">
              <AlertCircle size={14} className="text-amber-700 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-700">
                <div className="font-semibold">
                  {effectiveUnresolved.length === 1
                    ? 'One placeholder still has no value.'
                    : `${effectiveUnresolved.length} placeholders still have no value.`}
                </div>
                <div className="mt-0.5">
                  {bodyOverride != null ? 'Edit the text below to fill: ' : 'Go back and fill: '}
                  {effectiveUnresolved.map((k) => (
                    <Fragment key={k}>
                      <code className="bg-amber-500/15 text-amber-800 rounded px-1 mr-1">{`{{${k}}}`}</code>
                    </Fragment>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-un1t-subtle">
                Preview
                {bodyOverride != null && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider bg-blue-500/10 text-blue-700 rounded-full px-1.5 py-0.5 align-middle">
                    Edited
                  </span>
                )}
              </label>
              <button
                type="button"
                onClick={() => {
                  if (editingBody) {
                    setEditingBody(false)
                    return
                  }
                  setBodyOverride((prev) => (prev == null ? preview : prev))
                  setEditingBody(true)
                }}
                className="text-xs text-un1t-subtle hover:text-un1t-text underline"
              >{editingBody ? 'Done editing' : 'Edit text'}</button>
            </div>

            {editingBody ? (
              <div className="space-y-2">
                <textarea
                  value={bodyOverride ?? ''}
                  onChange={(e) => setBodyOverride(e.target.value)}
                  rows={12}
                  className="w-full bg-white text-gray-900 border border-un1t-border rounded-md p-3 font-mono text-xs leading-relaxed"
                />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 text-xs">
                    <button
                      type="button"
                      onClick={() => setEditPreviewMode('formatted')}
                      className={`px-2 py-1 rounded-md ${editPreviewMode === 'formatted' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
                    >Formatted</button>
                    <button
                      type="button"
                      onClick={() => setEditPreviewMode('raw')}
                      className={`px-2 py-1 rounded-md ${editPreviewMode === 'raw' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
                    >Raw</button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const ok = window.confirm(
                        'Reset to the template text? Your manual edits will be discarded.'
                      )
                      if (!ok) return
                      setBodyOverride(null)
                      setEditingBody(false)
                    }}
                    className="text-xs text-red-700 hover:text-red-800"
                  >Reset to template</button>
                </div>
                <div className="bg-white text-gray-900 border border-un1t-border rounded-md p-4 max-h-[300px] overflow-auto">
                  {editPreviewMode === 'raw' ? (
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {renderPreviewWithHighlights(bodyOverride || '')}
                    </div>
                  ) : (
                    <ContractBody markdown={bodyOverride || ''} />
                  )}
                </div>
              </div>
            ) : effectiveUnresolved.length > 0 ? (
              // Raw view — while placeholders are still unresolved we
              // show the literal markdown source with each unfilled
              // {{placeholder}} highlighted, so the issuer can see
              // exactly where they'll appear in the final document.
              // Rendering this through ContractBody would hide the
              // literal {{...}} runs inside markdown formatting, so
              // the raw view stays plain text until everything resolves.
              <div className="bg-white text-gray-900 border border-un1t-border rounded-md p-4 max-h-[400px] overflow-auto whitespace-pre-wrap text-sm leading-relaxed">
                {renderPreviewWithHighlights(effectiveBody)}
              </div>
            ) : (
              <div className="bg-white text-gray-900 border border-un1t-border rounded-md p-4 max-h-[400px] overflow-auto">
                <ContractBody markdown={effectiveBody} />
              </div>
            )}
            {/* CONTRACTS-VARS.2 — location vars are never resolvable
                client-side. Plain preview: a reassurance that the
                bracketed stand-ins become real values at issue time.
                Hand-edited (bodyOverride) text is sent verbatim
                instead — no server-side substitution happens into an
                override — so that case gets a stronger warning to
                replace the brackets manually. */}
            {templateUsesLocationVars && bodyOverride == null && (
              <p className="text-[11px] text-un1t-muted mt-1">
                Location details are filled in automatically when the contract is issued.
              </p>
            )}
            {templateUsesLocationVars && bodyOverride != null && (
              <p className="text-[11px] text-amber-700 mt-1">
                This text was seeded with bracketed placeholders (e.g. <code>[location name]</code>) for location details.
                Hand-edited text is sent exactly as written, with no automatic fill-in. Replace those brackets with the real values before issuing.
              </p>
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
              onClick={() => goBack(2)}
              className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
            >← Back</button>
            <div className="flex items-center gap-2">
              {/* CONTRACTS-DRAFT.1 — same validation gates as issuing
                  (placeholders resolved, countersign filled); the only
                  difference server-side is save_as_draft in the
                  payload, which skips the email/push entirely. */}
              <button
                type="button"
                disabled={!issuerSig || busy || effectiveUnresolved.length > 0}
                onClick={() => handleIssue(true)}
                title={
                  effectiveUnresolved.length > 0
                    ? `Fill ${effectiveUnresolved.length} remaining placeholder${effectiveUnresolved.length === 1 ? '' : 's'} before saving.`
                    : undefined
                }
                className="text-xs px-4 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50 inline-flex items-center gap-1"
              >
                {busy && pendingAction === 'draft' ? 'Saving…' : 'Save as draft'}
              </button>
              <button
                type="button"
                disabled={!issuerSig || busy || effectiveUnresolved.length > 0}
                onClick={() => handleIssue(false)}
                title={
                  effectiveUnresolved.length > 0
                    ? `Fill ${effectiveUnresolved.length} remaining placeholder${effectiveUnresolved.length === 1 ? '' : 's'} before issuing.`
                    : undefined
                }
                className="text-xs bg-un1t-text text-un1t-bg px-4 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50 inline-flex items-center gap-1"
              >
                <FileText size={11} /> {busy && pendingAction === 'issue' ? 'Issuing…' : 'Issue contract'}
              </button>
            </div>
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
