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
import Link from 'next/link'
import { ChevronRight, ChevronLeft, FileText, AlertCircle, Info, Search } from 'lucide-react'
import {
  renderTemplate, profileVariables, unresolvedPlaceholders, unresolvedPlaceholdersUnion,
  eligibleTemplatesFor, extractPlaceholders, customVariablesFrom, LOCATION_VAR_KEYS,
} from '@/lib/contracts'
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
  // CONTRACTS-BULK.1 — recipient selection is now a set. The single-
  // recipient case (profileIds.length === 1) must behave exactly like
  // the old `profileId` string state did downstream — every derived
  // value below reduces to its old single-value form when there's
  // just one selected id.
  const [profileIds, setProfileIds] = useState([])
  const [recipientFilter, setRecipientFilter] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [vars, setVars] = useState({})
  const [issuerSig, setIssuerSig] = useState(issuerName || '')
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState(null) // 'issue' | 'draft' | null
  const [error, setError] = useState(null)

  // CONTRACTS-BULK.1 — step-3 pager: which recipient's preview tab is
  // showing. Irrelevant (stays 0) for the single-recipient case.
  const [previewIndex, setPreviewIndex] = useState(0)

  // CONTRACTS-BULK.1 — bulk issue/draft results. null until a bulk
  // run (>1 recipient) starts; then one row per recipient tracking
  // pending/success/error, replacing the auto-redirect for N>1.
  // Progress ("Issuing 3 of 5…") is derived from this list rather
  // than tracked separately — see processedCount/bulkTotal below.
  // bulkAsDraft remembers which action (issue vs draft) started the
  // run so "Retry failed" repeats the same one, and so the progress/
  // summary copy reads "Saving"/"Issuing" correctly. State (not a
  // ref) — it's read during render for that copy.
  const [results, setResults] = useState(null)
  const [bulkAsDraft, setBulkAsDraft] = useState(false)

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
        // CONTRACTS-BULK.1 — a re-issue prefill always selects just
        // the one recipient the previous contract was for.
        if (c.profile_id) setProfileIds([c.profile_id])
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

  // CONTRACTS-BULK.1 — resolved recipient profiles in selection order.
  const recipients = useMemo(
    () => profileIds.map(id => staff.find(s => s.id === id)).filter(Boolean),
    [staff, profileIds],
  )
  // Back-compat single-recipient alias. Every piece of logic below
  // that only ever cared about "the" recipient (profile-var
  // derivation for the unmapped-keys list, the single-recipient
  // preview/body-override flow) keeps using this — it's recipients[0],
  // so a single selection reduces to byte-for-byte the same value the
  // old `profileId`-derived `recipient` produced.
  const recipient = recipients[0] || null

  const filteredStaff = useMemo(() => {
    const q = recipientFilter.trim().toLowerCase()
    if (!q) return staff
    return staff.filter(s => {
      const hay = `${s.full_name || ''} ${s.email || ''} ${s.employment_type || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [staff, recipientFilter])

  const template = useMemo(
    () => templates.find(t => t.id === templateId) || null,
    [templates, templateId],
  )
  const eligibleTemplates = useMemo(
    () => eligibleTemplatesFor(recipients, templates),
    [templates, recipients],
  )

  // CONTRACTS-BULK.1 — if a recipient is added/removed such that the
  // currently-chosen template is no longer eligible for every
  // selected recipient, clear it rather than silently letting an
  // ineligible template ride through to step 2. Guarded on both
  // fetches having resolved (templates.length > 0, and every
  // profileId having resolved to a staff row) so this doesn't fire —
  // and wipe a valid ?from= prefill — while the initial /api/staff +
  // /api/contract-templates or /api/contracts/[id] fetches are still
  // in flight and racing each other.
  useEffect(() => {
    if (!templateId) return
    if (templates.length === 0) return
    if (recipients.length !== profileIds.length) return
    if (!eligibleTemplates.some(t => t.id === templateId)) setTemplateId('')
  }, [eligibleTemplates, templateId, templates, recipients, profileIds])

  function toggleRecipient(id) {
    setProfileIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

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

  // CONTRACTS-BULK.1 — one rendered preview per selected recipient
  // (custom `vars` are shared; profile auto-fills are per-recipient).
  // Location vars still get the bracketed stand-in — see
  // LOCATION_VAR_PREVIEW above.
  const previews = useMemo(() => {
    if (!template) return []
    return recipients.map(r => ({
      profileId: r.id,
      recipient: r,
      name: r.full_name,
      text: renderTemplate(template.body_markdown, { ...profileVariables(r), ...LOCATION_VAR_PREVIEW, ...vars }),
    }))
  }, [template, recipients, vars])

  // Back-compat: the single-recipient preview. previews[0] is exactly
  // what the old `preview` memo produced when there was one recipient
  // (both are '' when there's no template/recipient).
  const preview = previews[0]?.text ?? ''

  // CONTRACTS-BULK.1 — step-3 pager. Clamp defensively (a recipient
  // could be removed while step 3 was showing a later tab — not
  // reachable via the current UI since step 1 is behind step 3, but
  // cheap insurance).
  useEffect(() => { setPreviewIndex(0) }, [templateId])
  const clampedPreviewIndex = previews.length === 0 ? 0 : Math.min(previewIndex, previews.length - 1)
  const currentPreview = previews[clampedPreviewIndex] || null

  // CONTRACTS-BULK.1 — placeholders that would render literally,
  // unioned across EVERY selected recipient (a key auto-fillable for
  // one recipient can still be missing for another — e.g.
  // annual_salary set on one profile but not the next). Reduces to
  // exactly the old single-recipient unresolvedPlaceholders() list
  // when there's one recipient. Drives the step-3 warning + gates
  // Save/Issue.
  const unresolvedDetail = useMemo(() => {
    if (!template || recipients.length === 0) return []
    return unresolvedPlaceholdersUnion(template.body_markdown, recipients, vars, { assumeKeys: LOCATION_VAR_KEYS })
  }, [template, recipients, vars])
  const stillUnfilled = useMemo(() => unresolvedDetail.map(d => d.key), [unresolvedDetail])

  // CONTRACTS-EDIT.1 — once the issuer hand-edits the body, the
  // "still unresolved" check moves from the template-render
  // placeholders to whatever's literally still in the edited text
  // (the override is the final text — there's no further variable
  // merge to reason about).
  const overrideUnresolvedKeys = useMemo(() => {
    if (bodyOverride == null) return []
    return extractPlaceholders(bodyOverride)
  }, [bodyOverride])
  // effectiveUnresolved gates advancing/issuing — the UNION across
  // every recipient (or the override's own placeholders when hand-
  // edited, single-recipient only). effectiveBody is what the visible
  // preview tab currently shows.
  const effectiveUnresolved = bodyOverride != null ? overrideUnresolvedKeys : stillUnfilled
  const effectiveBody = bodyOverride != null ? bodyOverride : (currentPreview?.text ?? '')
  // CONTRACTS-BULK.1 — which placeholders are STILL unresolved for the
  // recipient tab currently on screen (a subset of the union above) —
  // decides whether that one tab renders raw+highlighted or formatted.
  // For a single recipient this is identical to effectiveUnresolved.
  const tabUnresolved = bodyOverride != null
    ? overrideUnresolvedKeys
    : (template && currentPreview
        ? unresolvedPlaceholders(template.body_markdown, currentPreview.recipient, vars, { assumeKeys: LOCATION_VAR_KEYS })
        : [])
  const isBulk = recipients.length > 1

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
    return profileIds.length > 0 && templateId
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
  //
  // CONTRACTS-BULK.1 — this is now the SINGLE-recipient path only,
  // unchanged from before B4 (redirect + warning-stash). handleIssue()
  // below routes here when exactly one recipient is selected; >1
  // recipient goes through runBulk() instead, which never redirects.
  async function handleIssueSingle(asDraft = false) {
    setBusy(true)
    setPendingAction(asDraft ? 'draft' : 'issue')
    setError(null)
    try {
      const payload = {
        template_id: templateId,
        profile_id: profileIds[0],
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

  // CONTRACTS-BULK.1 — one POST per recipient, same payload shape as
  // the single-recipient path MINUS body_override (B1 hand-edits are
  // disabled for >1 recipient — see the step-3 "Edit text" gating
  // below). Never throws — failures come back as a result row so one
  // bad recipient doesn't abort the rest of the batch.
  async function issueOneRecipient(r, asDraft) {
    const payload = {
      template_id: templateId,
      profile_id: r.id,
      variables: vars,
      issuer_signature: issuerSig,
    }
    if (asDraft) payload.save_as_draft = true
    try {
      const res = await fetch('/api/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      return { profileId: r.id, name: r.full_name, status: 'success', contractId: json.data.id }
    } catch (e) {
      return { profileId: r.id, name: r.full_name, status: 'error', error: e.message }
    }
  }

  // Runs the recipients in `targets` sequentially, live-updating the
  // matching row in `results` after each one settles. Shared by the
  // initial bulk run and "Retry failed" (which only re-runs the rows
  // still in 'error').
  async function runBulk(targets, asDraft) {
    setBulkAsDraft(asDraft)
    for (const r of targets) {
      const outcome = await issueOneRecipient(r, asDraft)
      setResults(prev => (prev || []).map(row => (row.profileId === outcome.profileId ? outcome : row)))
    }
  }

  // CONTRACTS-BULK.1 — dispatcher: exactly one recipient behaves
  // EXACTLY as before (handleIssueSingle, redirect included); more
  // than one recipient switches to the sequential-loop + results-
  // panel flow (no redirect — see the step-3 render below).
  async function handleIssue(asDraft = false) {
    if (recipients.length <= 1) {
      return handleIssueSingle(asDraft)
    }
    setBusy(true)
    setPendingAction(asDraft ? 'draft' : 'issue')
    setError(null)
    setResults(recipients.map(r => ({ profileId: r.id, name: r.full_name, status: 'pending' })))
    await runBulk(recipients, asDraft)
    setBusy(false)
    setPendingAction(null)
  }

  async function retryFailed() {
    if (!results) return
    const failedIds = results.filter(r => r.status === 'error').map(r => r.profileId)
    if (failedIds.length === 0) return
    const targets = recipients.filter(r => failedIds.includes(r.id))
    setBusy(true)
    setPendingAction(bulkAsDraft ? 'draft' : 'issue')
    setResults(prev => prev.map(row => (failedIds.includes(row.profileId) ? { ...row, status: 'pending', error: undefined } : row)))
    await runBulk(targets, bulkAsDraft)
    setBusy(false)
    setPendingAction(null)
  }

  // Live progress figures for the "Issuing 3 of 5…" label + the
  // results-panel summary line.
  const processedCount = results ? results.filter(r => r.status !== 'pending').length : 0
  const bulkTotal = results ? results.length : recipients.length

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
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-un1t-subtle">Recipients</label>
              {profileIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setProfileIds([])}
                  className="text-xs text-un1t-subtle hover:text-un1t-text underline"
                >Clear ({profileIds.length})</button>
              )}
            </div>
            <div className="relative mb-2">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-un1t-muted" />
              <input
                type="text"
                value={recipientFilter}
                onChange={e => setRecipientFilter(e.target.value)}
                placeholder="Filter by name, email, or employment type…"
                className="w-full bg-un1t-bg border border-un1t-border rounded-md pl-8 pr-3 py-2 text-sm"
              />
            </div>
            <div className="border border-un1t-border rounded-md max-h-64 overflow-y-auto divide-y divide-un1t-border">
              {filteredStaff.length === 0 ? (
                <p className="text-xs text-un1t-muted italic p-3">No staff match &quot;{recipientFilter}&quot;.</p>
              ) : (
                filteredStaff.map(s => (
                  <label
                    key={s.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-un1t-bg"
                  >
                    <input
                      type="checkbox"
                      checked={profileIds.includes(s.id)}
                      onChange={() => toggleRecipient(s.id)}
                      className="shrink-0"
                    />
                    <span>{s.full_name} · {s.email} · {s.employment_type || 'unknown'}</span>
                  </label>
                ))
              )}
            </div>
            {profileIds.length > 0 && (
              <p className="text-xs text-un1t-muted mt-1">
                {profileIds.length} recipient{profileIds.length === 1 ? '' : 's'} selected.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Template</label>
            <select
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              disabled={profileIds.length === 0}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm disabled:opacity-50"
            >
              <option value="">{profileIds.length > 0 ? 'Pick a template…' : 'Pick at least one recipient first'}</option>
              {eligibleTemplates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} (v{t.version})
                </option>
              ))}
            </select>
            {profileIds.length > 0 && eligibleTemplates.length === 0 && (
              <p className="text-xs text-amber-700 mt-1">
                No active templates match every selected recipient&apos;s employment type. Create one
                first, or narrow the selection.
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
          {isBulk ? (
            <p className="text-xs text-un1t-subtle">
              Profile fields (full name, email, role, salary etc.) are auto-filled per recipient
              from each person&apos;s own record. Custom variables below are shared across all{' '}
              {recipients.length} recipients.
            </p>
          ) : (
            <p className="text-xs text-un1t-subtle">
              Profile fields ({recipient?.full_name}, {recipient?.email}, role, salary etc.) are
              auto-filled from the recipient&apos;s record. Just supply any custom variables this
              template needs.
            </p>
          )}
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
                  {effectiveUnresolved.map((k) => {
                    // CONTRACTS-BULK.1 — for >1 recipient, name which
                    // recipient(s) this key is still missing for
                    // (e.g. a key auto-filled from one profile but not
                    // another's — see unresolvedPlaceholdersUnion()).
                    const detail = unresolvedDetail.find((d) => d.key === k)
                    const names = (bodyOverride == null && isBulk && detail)
                      ? ` (${detail.recipients.map((r) => r.full_name).join(', ')})`
                      : ''
                    return (
                      <Fragment key={k}>
                        <code className="bg-amber-500/15 text-amber-800 rounded px-1 mr-1">{`{{${k}}}`}</code>
                        {names && <span className="mr-1">{names}</span>}
                      </Fragment>
                    )
                  })}
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
              {/* CONTRACTS-BULK.1 — the B1 hand-edit editor only makes
                  sense for one recipient at a time (there's exactly one
                  body_override slot server-side); hide it entirely for
                  a bulk selection rather than editing one recipient's
                  copy and silently applying it to nobody. */}
              {isBulk ? (
                <span className="text-[11px] text-un1t-muted">
                  Manual text edits are available when issuing to a single recipient.
                </span>
              ) : (
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
              )}
            </div>

            {/* CONTRACTS-BULK.1 — >1 recipient gets a compact tab
                strip to flip between each recipient's own preview
                (shared custom vars + that recipient's profile vars +
                location stand-ins). Single recipient never renders
                this — same "there's just one preview" visual as
                before B4. */}
            {isBulk && previews.length > 0 && (
              <div className="flex items-center gap-1 mb-2 flex-wrap">
                <button
                  type="button"
                  disabled={clampedPreviewIndex === 0}
                  onClick={() => setPreviewIndex(i => Math.max(0, i - 1))}
                  className="p-1 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-30"
                ><ChevronLeft size={12} /></button>
                <div className="flex items-center gap-1 flex-wrap">
                  {previews.map((p, i) => (
                    <button
                      key={p.profileId}
                      type="button"
                      onClick={() => setPreviewIndex(i)}
                      className={`text-[11px] px-2 py-1 rounded-full border ${
                        i === clampedPreviewIndex
                          ? 'bg-un1t-text text-un1t-bg border-un1t-text'
                          : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
                      }`}
                    >{p.name}</button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={clampedPreviewIndex === previews.length - 1}
                  onClick={() => setPreviewIndex(i => Math.min(previews.length - 1, i + 1))}
                  className="p-1 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-30"
                ><ChevronRight size={12} /></button>
              </div>
            )}

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
            ) : tabUnresolved.length > 0 ? (
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

          {/* CONTRACTS-BULK.1 — once a bulk run has started, `results`
              takes over the bottom of step 3: the Save/Issue buttons
              (which would otherwise re-run the WHOLE batch, including
              recipients that already succeeded) are replaced by a
              live per-recipient status list + a Retry that only
              re-runs the ones that failed. Single recipient never
              sets `results` — that path keeps the original
              redirect-on-success flow below, unchanged. */}
          {results ? (
            <div className="space-y-2">
              <p className="text-xs text-un1t-subtle">
                {busy
                  ? `${bulkAsDraft ? 'Saving' : 'Issuing'} ${Math.min(processedCount + 1, bulkTotal)} of ${bulkTotal}…`
                  : `${results.filter(r => r.status === 'success').length} of ${bulkTotal} ${bulkAsDraft ? 'saved as drafts' : 'issued'}${results.some(r => r.status === 'error') ? `, ${results.filter(r => r.status === 'error').length} failed` : ''}.`}
              </p>
              <ul className="border border-un1t-border rounded-md divide-y divide-un1t-border">
                {results.map(r => (
                  <li key={r.profileId} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{r.name}</span>
                    {r.status === 'pending' && <span className="text-xs text-un1t-muted">Waiting…</span>}
                    {r.status === 'success' && (
                      <Link href={`/admin/contracts/${r.contractId}`} className="text-xs text-emerald-700 underline">
                        Open
                      </Link>
                    )}
                    {r.status === 'error' && <span className="text-xs text-red-700">{r.error}</span>}
                  </li>
                ))}
              </ul>
              {!busy && results.some(r => r.status === 'error') && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={retryFailed}
                    className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
                  >Retry failed</button>
                </div>
              )}
            </div>
          ) : (
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
                  {busy && pendingAction === 'draft'
                    ? 'Saving…'
                    : isBulk ? `Save ${recipients.length} drafts` : 'Save as draft'}
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
                  <FileText size={11} /> {busy && pendingAction === 'issue'
                    ? 'Issuing…'
                    : isBulk ? `Issue ${recipients.length} contracts` : 'Issue contract'}
                </button>
              </div>
            </div>
          )}
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
