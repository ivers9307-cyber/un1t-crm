'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { BarChart3 } from 'lucide-react'
import { CANCELLATION_FORM_DEFAULTS, REASON_CODES } from '@/lib/cancellation-form/defaults'
import ReadFailedNote from '@/components/settings/ReadFailedNote'
import { hubManageHref } from '@/lib/integrations-hub-links'
import { zoneCity } from '@/lib/record-time'
// MIAORG.1 Task 3 — which fields this studio sets itself (zod-free, shared
// with the PUT's contract).
import {
  initialOverridden, withOverride, withoutOverride, valueAt, fieldSource, orgSetsAny,
  isOverridden, INHERITABLE_SCALAR_KEYS, INHERITABLE_OBJECT_KEYS, INHERITABLE_OBJECT_FIELDS, isHalfQuietWindow,
  TRIAL_DONE_MIA_INSTRUCTION_DEFAULT,
} from '@/lib/agent/settings-overrides'
import {
  buildSavePayload, bookingLinkErrors, bookingIssuesFromResponse,
  trialDoneErrors, parseTrialDoneContactIds,
} from './save-payload'
// MIASETTINGS.1c — the plain fields render from the one registry.
import { fieldsFor } from './fields'
import AgentField from './components/AgentField'
import SourceTag from './components/SourceTag'
import { HATCH_COPY_FIELDS, HATCH_COPY_GROUP_TITLE } from './hatch-copy-fields'
import MiaOffersSection from './MiaOffersSection'
// MIAORG.1 Task 4 — the organisation defaults, for masters and org admins.
import OrgDefaultsClient from './OrgDefaultsClient'

// RADAR-AGENT.0 — operator settings for the customer-facing WhatsApp /
// Instagram agent. Manager+ only. Two parts: behaviour settings + the
// knowledge editor the agent answers from (channel connections moved to
// the per-location Integrations tab strip — IG-HOME.1; a pointer card
// keeps the old path discoverable). Ships OFF by default.

const CATEGORIES = ['sales', 'account', 'pause', 'cancellation', 'hours', 'general', 'faq']

// CANCEL-FORM.2 — placeholders + reason codes come from the pure copy module
// (no server-only imports), so the editor's defaults can never drift from
// what the form actually renders.
const CF_DEFAULTS = CANCELLATION_FORM_DEFAULTS
const CF_REASON_CODES = REASON_CODES

// MIAORG.1 Task 3 — a field label with its source tag ("Organisation
// default" / "Default", or the "Use organisation default" link) beside it.
// For the custom editors (quiet hours, template pickers, trial finisher);
// the plain fields use AgentField.
function FieldLabel({ tag, children }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1">
      <label className="block text-sm font-medium text-un1t-text">{children}</label>
      {tag}
    </div>
  )
}

// MIAROLE.1 (C80) — `canEdit` comes from the server page (canEditMiaSettings:
// owner at the active studio, or master), the same predicate the PUT gates
// on. Omitted, it fails closed: the settings render read-only, with no Save.
// The knowledge editor below is outside that rule.
// MIAORG.1 Task 4 — `orgDefaults` ({ organizationId, organizationName }) is
// set by the server page only for a master or an admin of the organisation
// (resolveAdminOrgId); it shows the organisation defaults section above this
// studio's settings. Null for everyone else: the page is exactly as before.
export default function CustomerAgentClient({ canEdit = false, orgDefaults = null } = {}) {
  const [settings, setSettings] = useState(null)
  const [location, setLocation] = useState(null)
  // W1.S3 — the studio's resolved brand (GET payload), for the placeholders.
  const [brand, setBrand] = useState({ companyName: '', shortName: '' })
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [checkinStats, setCheckinStats] = useState(null)
  const [error, setError] = useState(null)
  // SETTINGSWIPE.1 — true when the settings GET failed. The editor must then
  // show nothing it could save: the GET used to answer a failed read with
  // the DEFAULTS, and Save wrote them back (Mia off).
  const [loadFailed, setLoadFailed] = useState(false)
  // MIAORG.1 Task 3 — the fields this studio sets itself (override paths:
  // 'tone', 'followups.daily_cap'). Only these are stored on Save; every other
  // inheritable field keeps following the organisation default (or the code
  // default), so a later org change still reaches this studio. Starts from
  // the stored blob: every value it holds counts as the studio's own (T3-D),
  // so the first save of a legacy full blob keeps all of it.
  const [overridden, setOverridden] = useState([])
  // The CURRENT override set, for work that finishes after an await
  // (refreshInherited runs after the org PUT; that render's `overridden`
  // would be stale if the operator edited a field meanwhile).
  const overriddenRef = useRef(overridden)
  useEffect(() => { overriddenRef.current = overridden }, [overridden])
  // The org layer (raw) and what each key resolves to with no override.
  const [org, setOrg] = useState(null)
  const [inherited, setInherited] = useState(null)
  // MIAORG.1 final review — false at a studio whose membership source takes
  // no bookings (GET `bookings`): the Booking link fields show there. An
  // older GET without the key shows them too (never hides a saved link).
  const [bookings, setBookings] = useState(null)
  // MIAHATCH.4 — the studio's membership source key (GET): the Hatch payments
  // and booking copy group shows only for 'un1t_online'.
  const [membershipSourceKey, setMembershipSourceKey] = useState(null)
  // The PUT's 400 issues on the booking fields, shown beside them.
  const [serverFieldErrors, setServerFieldErrors] = useState({})

  // After a save (refreshSettings). load() sets the same state inline.
  function applySettingsResponse(sRes) {
    setSettings(sRes.settings); setLocation(sRes.location || null); setCheckinStats(sRes.checkin_stats || null)
    setBrand(sRes.brand || { companyName: '', shortName: '' })
    setOverridden(initialOverridden(sRes.studio))
    setOrg(sRes.org || null)
    setInherited(sRes.inherited || null)
    setBookings(typeof sRes.bookings === 'boolean' ? sRes.bookings : null)
    setMembershipSourceKey(typeof sRes.membership_source_key === 'string' ? sRes.membership_source_key : null)
  }

  async function load(isCancelled = () => false) {
    try {
      // allSettled: a failed KNOWLEDGE read must not be reported as a failed
      // settings read (the editor would hide a Save it can safely offer).
      const [sOut, kOut] = await Promise.allSettled([
        fetch('/api/settings/customer-agent').then(r => r.json()),
        fetch('/api/agent/knowledge').then(r => r.json()),
      ])
      if (isCancelled()) return
      const sRes = sOut.status === 'fulfilled' ? sOut.value : null
      if (sRes?.success && sRes.settings) {
        // Inline (not applySettingsResponse) so the mount effect below keeps
        // depending on nothing reactive; keep the two in step.
        setSettings(sRes.settings); setLocation(sRes.location || null); setCheckinStats(sRes.checkin_stats || null)
        setBrand(sRes.brand || { companyName: '', shortName: '' })
        setOverridden(initialOverridden(sRes.studio)); setOrg(sRes.org || null); setInherited(sRes.inherited || null)
        setBookings(typeof sRes.bookings === 'boolean' ? sRes.bookings : null)
        setMembershipSourceKey(typeof sRes.membership_source_key === 'string' ? sRes.membership_source_key : null)
        setLoadFailed(false)
      } else {
        setSettings(null); setLoadFailed(true)
      }
      if (kOut.status === 'fulfilled' && kOut.value?.success) setEntries(kOut.value.entries || [])
    } catch {
      if (!isCancelled()) { setSettings(null); setLoadFailed(true) }
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    load(() => cancelled)
    return () => { cancelled = true }
    // load is re-created each render and only ever sets state; run once on mount.
  }, [])

  // Editing an inheritable field makes it this studio's own (studio-only and
  // sibling keys are ignored by withOverride: they are always saved).
  function markOverridden(...paths) { setOverridden(o => withOverride(o, ...paths)) }
  function setField(k, v) {
    setSettings(s => ({ ...s, [k]: v })); markOverridden(k)
    setServerFieldErrors(e => (k in e ? Object.fromEntries(Object.entries(e).filter(([f]) => f !== k)) : e))
  }
  // Quiet hours are a pair: editing either end makes both the studio's own
  // (and ends a "no quiet hours" opt-out).
  function setQuietHours(k, v) {
    setSettings(s => {
      const { off: _off, ...q } = s.quiet_hours || {}
      return { ...s, quiet_hours: { ...q, [k]: v } }
    })
    setOverridden(o => withOverride(withoutOverride(o, 'quiet_hours.off'), 'quiet_hours.start', 'quiet_hours.end'))
  }
  // MIAORG.1 Task 4 (T4-A) — "No quiet hours (ignore the organisation's)".
  // Null cannot say "none" once the organisation sets quiet hours, so the
  // studio stores `quiet_hours.off`. Ticking clears start and end; unticking
  // drops the opt-out, so the window is inherited again.
  function setNoQuietHours(on) {
    if (on) {
      setSettings(s => ({ ...s, quiet_hours: { start: null, end: null, tz: null, off: true } }))
      setOverridden(o => withOverride(withoutOverride(o, 'quiet_hours.start', 'quiet_hours.end', 'quiet_hours.tz'), 'quiet_hours.off'))
    } else {
      setOverridden(o => withoutOverride(o, 'quiet_hours'))
      setSettings(s => {
        const q = inherited?.quiet_hours
        return { ...s, quiet_hours: q && typeof q === 'object' ? { ...q } : null }
      })
    }
  }
  const noQuietHours = settings?.quiet_hours?.off === true
  // MIAORG.1 Task 4 — one end of the window only: the payload would drop it
  // silently, so the editor says "Set both times" and holds Save.
  const quietHalf = isHalfQuietWindow(settings?.quiet_hours)
  // MIAORG.1 final review — the Booking link fields, checked as the PUT
  // checks them; an invalid value shows beside its field and holds Save.
  // MIAHATCH.4 (Task 14): a un1t.online studio books through Mia now, but the
  // link stays as the fallback (and Mia's answer where a class cannot be
  // booked), so its fields show there whatever `bookings` says.
  const showBookingLink = bookings !== true || membershipSourceKey === 'un1t_online'
  const bookingErrors = { ...serverFieldErrors, ...bookingLinkErrors(settings) }
  const bookingInvalid = showBookingLink && Object.keys(bookingLinkErrors(settings)).length > 0
  // TRIALDONE.3 — the trial-finisher card (a un1t.online studio only), checked
  // as the PUT checks it; an invalid value shows beside its field and holds Save.
  const showTrialDone = membershipSourceKey === 'un1t_online'
  const trialErrors = showTrialDone ? trialDoneErrors(settings) : {}
  const trialInvalid = Object.keys(trialErrors).length > 0

  // "Use organisation default": the field stops being the studio's own and
  // shows the value it now inherits (GET's `inherited`).
  function revertToInherited(paths) {
    setOverridden(o => withoutOverride(o, ...paths))
    setSettings(s => {
      const next = { ...s }
      for (const p of paths) {
        const dot = p.indexOf('.')
        if (dot < 0) {
          const v = inherited?.[p]
          next[p] = v && typeof v === 'object' ? { ...v } : (v ?? null)
        } else {
          const key = p.slice(0, dot)
          next[key] = { ...(next[key] || {}), [p.slice(dot + 1)]: valueAt(inherited, p) ?? null }
        }
      }
      return next
    })
  }

  // A cleared number field shows what it then inherits, as its placeholder.
  const inheritedNumber = (path, fallback) => String(valueAt(inherited, path) ?? fallback)

  // The tag beside an inheritable field's label (staff copy, T3-F;
  // components/SourceTag.jsx since MIASETTINGS.1c). A whole object key
  // (quiet_hours) counts as set at the organisation only on a set FIELD.
  function tagFor(paths) {
    return (
      <SourceTag source={fieldSource(paths, { overridden, org })} canEdit={canEdit}
        orgHas={orgSetsAny(paths, org)} onRevert={() => revertToInherited(paths)} />
    )
  }

  // AGENT-CHECKIN.2 — humanise the last tick's skip-reason tally.
  function describeCheckinReasons(checkins) {
    const reasons = checkins?.reasons || {}
    const parts = Object.entries(reasons).map(([k, n]) => `${k.replace(/_/g, ' ')} ×${n}`)
    if (checkins?.reason === 'quiet_hours') parts.unshift('quiet hours')
    return parts.length ? ` (${parts.join(', ')})` : ''
  }

  // CHECKINSTALL.1 — one line per Dublin day from last_outcome.checkins_day.
  // Counts are per 15-minute run, not per person (one lead skipped all
  // afternoon shows ×20). Staff copy, not customer-facing.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  function describeCheckinDay(d) {
    if (!d?.day) return null
    const [, mm, dd] = d.day.split('-')
    const label = `${Number(dd)} ${MONTHS[Number(mm) - 1] || ''}`
    const sent = (d.freeform || 0) + (d.templates || 0)
    const runs = d.daytime_ticks || 0
    const checks = d.candidates || 0
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
    const failed = d.failed_ticks ? ` · ${plural(d.failed_ticks, 'failed run')}` : ''
    const partial = d.carry_failed ? ' (partial: an earlier run could not be read)' : ''
    return `${label}: ${plural(runs, 'daytime run')} · ${plural(checks, 'candidate check')} · ${sent} sent · ${d.skipped || 0} skipped${describeCheckinReasons({ reasons: d.reasons })}${failed}${partial}`
  }

  async function saveSettings() {
    setSaving(true); setError(null)
    try {
      // MIAORG.1 Task 3 — pure (./save-payload.js), so the Stillorgan round
      // trip test runs this exact body.
      const payload = buildSavePayload(settings, overridden)
      const res = await fetch('/api/settings/customer-agent', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (j.success) {
        setSavedAt(Date.now()); setServerFieldErrors({})
        await refreshSettings()
      } else {
        setServerFieldErrors(bookingIssuesFromResponse(j.issues))
        setError(j.error || 'Failed to save')
      }
    } catch { setError('Failed to save') } finally { setSaving(false) }
  }

  // MIAORG.1 Task 3 — after a save, re-read so every tag and value shows the
  // truth (a field cleared to blank is "not set here" and inherits again).
  // Settings only: a knowledge edit in progress is never overwritten. A failed
  // re-read keeps what is on screen (the save itself succeeded).
  async function refreshSettings() {
    try {
      const sRes = await fetch('/api/settings/customer-agent').then(r => r.json())
      if (sRes?.success && sRes.settings) applySettingsResponse(sRes)
    } catch { /* keep the edited state; the save went through */ }
  }

  // MIAORG.1 Task 4 — after an ORGANISATION save: re-read what this studio
  // inherits and show it in every field the studio does not set, without
  // touching the studio's own (possibly unsaved) edits.
  async function refreshInherited() {
    try {
      const sRes = await fetch('/api/settings/customer-agent').then(r => r.json())
      if (!sRes?.success || !sRes.settings) return
      const nextInherited = sRes.inherited || null
      setOrg(sRes.org || null)
      setInherited(nextInherited)
      setSettings(s => {
        if (!s) return s
        // Read when React applies the update, so an edit made while the org
        // save was in flight keeps the operator's value.
        const overridden = overriddenRef.current
        const next = { ...s }
        for (const k of INHERITABLE_SCALAR_KEYS) {
          if (!isOverridden(overridden, k)) next[k] = nextInherited?.[k] ?? null
        }
        for (const key of INHERITABLE_OBJECT_KEYS) {
          // A studio that switched quiet hours off keeps showing none.
          if (key === 'quiet_hours' && isOverridden(overridden, 'quiet_hours.off')) continue
          const obj = { ...(next[key] || {}) }
          for (const f of INHERITABLE_OBJECT_FIELDS[key]) {
            if (!isOverridden(overridden, `${key}.${f}`)) obj[f] = valueAt(nextInherited, `${key}.${f}`) ?? null
          }
          next[key] = obj
        }
        return next
      })
    } catch { /* the org save went through; this studio's screen keeps what it shows */ }
  }

  // AGENT-FOLLOWUP.1 — approved templates for the stage-2 picker. The
  // template COPY lives in the WhatsApp Templates manager (edit &
  // resubmit there any time); this picker just selects which one the
  // follow-up uses — fully updatable without code.
  const [templates, setTemplates] = useState([])
  useEffect(() => {
    fetch('/api/whatsapp/templates')
      .then(r => r.json())
      .then(j => {
        const list = j.templates || j.data || []
        setTemplates(list.filter(t => String(t.status || '').toUpperCase() === 'APPROVED'))
      })
      .catch(() => {})
  }, [])
  // Object keys are overridden per field (MIAORG.1 Task 3).
  const setFollowup = (key, value) => {
    setSettings(s => ({ ...s, followups: { ...(s.followups || {}), [key]: value } }))
    markOverridden(`followups.${key}`)
  }
  const setCheckin = (key, value) => {
    setSettings(s => ({ ...s, first_class_checkin: { ...(s.first_class_checkin || {}), [key]: value } }))
    markOverridden(`first_class_checkin.${key}`)
  }
  // TRIALDONE.3 — studio-only, so no override bookkeeping: the block is always saved.
  const setTrialDone = (key, value) =>
    setSettings(s => ({ ...s, trial_done: { ...(s.trial_done || {}), [key]: value } }))
  // MIASETTINGS.1c — a registry field's edit, by its settings path: a plain
  // key (setField) or one field of an object key ('followups.daily_cap'),
  // overridden per field as setFollowup / setCheckin do.
  function setPath(path, value) {
    const dot = path.indexOf('.')
    if (dot < 0) { setField(path, value); return }
    const key = path.slice(0, dot)
    setSettings(s => ({ ...s, [key]: { ...(s[key] || {}), [path.slice(dot + 1)]: value } }))
    markOverridden(path)
  }
  // CANCEL-FORM.2 — nested editors for the cancellation-form block.
  const setCancelForm = (key, value) =>
    setSettings(s => ({ ...s, cancellation_form: { ...(s.cancellation_form || {}), [key]: value } }))
  const setCancelReason = (code, value) =>
    setSettings(s => ({
      ...s,
      cancellation_form: {
        ...(s.cancellation_form || {}),
        reason_labels: { ...((s.cancellation_form || {}).reason_labels || {}), [code]: value },
      },
    }))

  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState(null)

  // KNOWLEDGE-IMPORT.1 — one click pulls the Glofox timetable's class
  // types + descriptions into knowledge. Existing titles are never
  // overwritten, so re-running after adding a class is safe.
  async function importFromGlofox() {
    setImporting(true); setError(null); setImportNote(null)
    try {
      const res = await fetch('/api/agent/knowledge/import-classes', { method: 'POST' })
      const j = await res.json()
      if (!j.success) { setError(j.error || 'Import failed'); return }
      if (j.imported?.length) setEntries(e => [...e, ...j.imported])
      const bits = []
      bits.push(`${j.imported?.length || 0} class${(j.imported?.length || 0) === 1 ? '' : 'es'} imported`)
      if (j.skipped?.length) bits.push(`${j.skipped.length} already in knowledge`)
      if (j.missing_description?.length) bits.push(`no Glofox description for: ${j.missing_description.join(', ')} (added as drafts — fill them in below)`)
      setImportNote(j.message || bits.join(' · '))
    } catch { setError('Import failed') } finally { setImporting(false) }
  }

  async function addEntry() {
    setError(null)
    try {
      const res = await fetch('/api/agent/knowledge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'sales', title: 'New entry', content: '', enabled: true }),
      })
      const j = await res.json()
      if (j.success) setEntries(e => [...e, j.entry])
      else setError(j.error || 'Could not add the entry')
    } catch { setError('Could not add the entry') }
  }
  function editLocal(id, patch) {
    setEntries(e => e.map(x => x.id === id ? { ...x, ...patch } : x))
  }
  async function persist(id, patch) {
    editLocal(id, patch)
    try {
      const res = await fetch(`/api/agent/knowledge/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const j = await res.json()
      if (!j.success) setError(j.error || 'Could not save the entry')
    } catch { setError('Could not save the entry') }
  }
  async function deleteEntry(id) {
    setEntries(e => e.filter(x => x.id !== id))
    await fetch(`/api/agent/knowledge/${id}`, { method: 'DELETE' })
  }

  if (loading) return <div className="p-6 text-sm text-un1t-muted">Loading…</div>
  if (loadFailed || !settings) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-xl font-bold text-un1t-text mb-4">Customer Agent</h1>
        <ReadFailedNote what="the customer agent settings" onRetry={() => load()} />
      </div>
    )
  }

  const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

  // MIASETTINGS.1c — the plain fields, from the one registry (fields.js).
  // fieldsFor applies each field's `when` (the booking link fields, the
  // Hatch-only ones) and builds labels and placeholders from this studio.
  const fieldCtx = { membershipSourceKey, bookings, brand, agentName: settings.agent_name }
  const registry = Object.fromEntries(fieldsFor('studio', null, fieldCtx).map(f => [f.id, f]))
  // An inheritable field ('both': the organisation can set it too) carries
  // its source tag; a studio-only one has none. A number field's placeholder
  // is what it inherits when cleared (inheritedNumber).
  function renderField(id, extra = {}) {
    const f = registry[id]
    if (!f) return null
    const path = f.paths[0]
    return (
      <AgentField key={id} field={f} ctx={fieldCtx} value={valueAt(settings, path)} onChange={setPath}
        tag={f.scope === 'both' ? tagFor(f.paths) : undefined}
        placeholder={f.kind === 'number' && f.fallback != null ? inheritedNumber(path, f.fallback) : undefined}
        {...extra} />
    )
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold text-un1t-text mb-1">Customer Agent</h1>
      <p className="text-sm text-un1t-muted mb-6">
        The AI assistant that answers customers on WhatsApp and Instagram. It only
        answers from the knowledge below and hands off to a human for anything it can&apos;t answer.
        Ships off by default — use Test mode to trial it on your own number first.
      </p>

      <Link
        href="/settings/customer-agent/analytics"
        className="inline-flex items-center gap-2 text-sm bg-un1t-surface border border-un1t-border rounded-lg px-4 py-2.5 mb-6 hover:border-un1t-subtle transition-colors"
      >
        <BarChart3 size={16} className="text-un1t-accent" />
        <span className="text-un1t-text">View agent activity</span>
        <span className="text-un1t-muted">— replies, escalations, what customers asked</span>
      </Link>

      {/* IG-HOME.1 — channel connections moved to the integrations (the
          Integrations hub since INTEGONE.1); this pointer keeps the old path
          discoverable, opening the hub's Instagram drawer for this studio. */}
      {location?.id && (
        <Link
          href={hubManageHref(location.id, 'instagram')}
          className="flex items-center justify-between border border-un1t-border rounded-lg px-4 py-3 mb-6 hover:border-un1t-subtle transition-colors"
        >
          <div>
            <div className="text-sm font-medium text-un1t-text">Channel connections</div>
            <div className="text-xs text-un1t-muted">
              WhatsApp and Instagram for {location.name} are managed under Settings → Integrations.
            </div>
          </div>
          <span className="text-xs text-un1t-text underline">Manage</span>
        </Link>
      )}

      {orgDefaults?.organizationId && (
        <OrgDefaultsClient
          organizationId={orgDefaults.organizationId}
          organizationName={orgDefaults.organizationName || null}
          onSaved={refreshInherited}
        />
      )}

      {!canEdit && (
        <p className="text-sm text-un1t-muted border border-un1t-border rounded-lg px-4 py-3 mb-6">
          Only an owner can change these settings.
        </p>
      )}

      {/* MIAROLE.1 — one disabled fieldset greys every settings control for a
          non-owner; the Save buttons are not rendered for them at all. */}
      <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
      {/* ── Behaviour ─────────────────────────────────────── */}
      <section className="space-y-5 border border-un1t-border rounded-lg p-5 mb-6">
        {/* MIAORG.1 Task 3 — what the source tags mean (staff copy). */}
        <p className="text-xs text-un1t-muted">
          A field tagged Organisation default or Default follows your organisation&apos;s setting, or the
          built-in default, until you change it here. Changing it sets it for this studio only.
          Use organisation default puts it back.
        </p>
        <label className="flex items-center gap-3">
          <input type="checkbox" className="h-4 w-4" checked={!!settings.enabled}
            onChange={e => setField('enabled', e.target.checked)} />
          <span className="text-sm text-un1t-text font-medium">Live — reply to all customers</span>
        </label>

        <div className="pl-7 space-y-3 border-l border-un1t-border ml-1">
          <label className="flex items-center gap-3">
            <input type="checkbox" className="h-4 w-4" checked={!!settings.test_mode}
              onChange={e => setField('test_mode', e.target.checked)} />
            <span className="text-sm text-un1t-text">Test mode — reply only to the numbers below (while not live)</span>
          </label>
          {/* Live-despite-test-mode tripwire: both flags on means the
              allowlist is NOT in effect. Documented behaviour, but operators
              read "test mode" as scoping and get surprised. */}
          {!!settings.enabled && !!settings.test_mode && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
              Live is on, so test mode is not scoping anything — Mia is replying to every customer, not just the numbers below. Turn Live off to use the test list.
            </div>
          )}
          <div>
            <label className="block text-xs text-un1t-muted mb-1">Test numbers (comma-separated, e.g. +353871234567)</label>
            <input className={inputCls} value={(settings.test_phones || []).join(', ')}
              onChange={e => setField('test_phones', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
              placeholder="+353871234567, +353879999999" />
          </div>
        </div>

        {/* MIASETTINGS.1c — every plain field below is drawn from the registry
            (fields.js) by AgentField, in today's order. A field whose `when`
            does not hold here (the booking link fields, the Hatch-only ones)
            is not drawn. */}

        {/* AGENT-HANDS.1 — class-booking autonomy. Consultations for
            new leads are always autonomous; this controls member
            CLASS bookings only. */}
        {renderField('booking_mode')}

        {renderField('handoff_cooldown_hours')}

        {/* MIA-BOARD.1 — auto-resolve. The manual Resolve was used exactly
            zero times in the feature's lifetime (121 parked threads at the
            25 Aug re-audit), so the queue now cleans itself. */}
        <div className="grid grid-cols-2 gap-3">
          {renderField('auto_resolve_after_reply_hours')}
          {renderField('auto_resolve_stale_hours')}
        </div>

        {/* MIA-HYGIENE.1 — reasoning effort and the verify-fail handoff: read
            live by the agent, editable here (the handoff bounded 1-5 so a
            typo can't disable the net). */}
        {renderField('effort')}
        {renderField('handoff_after_verify_failures')}

        {renderField('agent_name')}
        {renderField('membership_signup_url')}

        {/* MIAORG.1 — booking link, at a studio whose membership source takes
            no bookings, and at a un1t.online studio (the fallback link).
            Studio-only, always saved; blank = no link (Mia hands bookings to
            the team). An invalid value shows beside its field. */}
        {renderField('booking_url', { error: bookingErrors.booking_url })}
        {renderField('booking_cta_label', { error: bookingErrors.booking_cta_label })}

        {/* Studio-only (final review): champ-app reads this studio's own value. */}
        {renderField('monthly_points_target')}
        {renderField('social_enabled')}
        {renderField('membership_cta_label')}

        {renderField('tone')}
        {renderField('extra_rules')}
        {renderField('holding_message')}

        {/* In-thread texts to the customer (AGENT-HANDS.1, AGENT-CANCEL.1,
            BOOKCHATCOPY.1, UN1TMOVE.2, UN1TCOMP.1, EVENT-MOVE.7, MIA-BOOK.1,
            MIA-CREDITS.1, PERSON-ACCT.7, FLOWACK.1, APPROVALS-STUDIO.1, C2,
            C3). Placeholders are the code defaults. MIA-EXPIRY-QUIET.1: the
            "Missed-booking apology" field lived here until 2026-08-31. */}
        {[
          'booking_confirmation_text', 'cancellation_confirmation_text', 'class_move_confirmation_text',
          'comp_credits_confirmation_text', 'event_move_confirmation_text', 'event_move_failed_text',
          'booking_issue_handoff_text', 'no_credits_handoff_text', 'account_conflict_handoff_text',
          'flow_booking_ack_text', 'flow_booking_holding_text', 'flow_booking_duplicate_text', 'flow_paid_trial_text',
          'approval_decline_text', 'welcome_greeting', 'link_button_text',
        ].map((id) => renderField(id))}

        {/* MIAHATCH.4 (spec 6.6) — what Mia and the pay pages say about booking
            and buying at a un1t.online studio (Hatch Street). Shown only there:
            a Glofox studio never says any of it. Placeholders are the code
            defaults (default-copy.js); blank = the default. MIAHATCH.5: Mia
            books, cancels and takes refund requests in chat here only with the
            switch ticked AND un1t.online writes on (MIAHATCH.6: payment links
            too). MIASETTINGS.1c: the booking form message is new at the studio,
            Hatch only (Mia sends the form only where she does not book in chat). */}
        {membershipSourceKey === 'un1t_online' && (
          <div className="space-y-4 border-t border-un1t-border pt-4" data-testid="hatch-copy-group">
            <h3 className="text-sm font-semibold text-un1t-text">{HATCH_COPY_GROUP_TITLE}</h3>
            {renderField('un1t_chat_actions_enabled')}
            <p className="text-xs text-un1t-muted">
              Messages customers get from Mia, and the two pages they land on after paying, at this studio. Leave a field blank to use the default shown.
            </p>
            {HATCH_COPY_FIELDS.map(({ key }) => renderField(key))}
            {renderField('booking_flow_text')}
          </div>
        )}

        <div>
          <FieldLabel tag={tagFor(['quiet_hours'])}>Quiet hours (optional)</FieldLabel>
          <div className="flex items-center gap-2 text-sm">
            <input type="time" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
              aria-label="Quiet hours start" disabled={noQuietHours}
              value={settings.quiet_hours?.start || ''}
              onChange={e => setQuietHours('start', e.target.value)} />
            <span className="text-un1t-muted">to</span>
            <input type="time" className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-un1t-text"
              aria-label="Quiet hours end" disabled={noQuietHours}
              value={settings.quiet_hours?.end || ''}
              onChange={e => setQuietHours('end', e.target.value)} />
            <span className="text-xs text-un1t-muted">{settings.quiet_hours?.tz || location?.timezone || "the studio's timezone"} — agent stays quiet, a human replies.</span>
          </div>
          {quietHalf && <p className="text-xs text-red-600 mt-1" role="alert">Set both times</p>}
          <label className="flex items-center gap-2 text-sm text-un1t-text mt-2">
            <input type="checkbox" className="h-4 w-4" checked={noQuietHours}
              onChange={e => setNoQuietHours(e.target.checked)} />
            No quiet hours (ignore the organisation&apos;s)
          </label>
        </div>

        {error && <div className="text-sm text-red-600">{error}</div>}
        {canEdit && (
          <div>
            <button type="button" onClick={saveSettings} disabled={saving || quietHalf || bookingInvalid || trialInvalid}
              className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50">
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            {savedAt && <span className="ml-3 text-sm text-green-600">Saved ✓</span>}
          </div>
        )}
      </section>

      {/* MIAHATCH.4 (Task 14) — the products Mia can sell at a un1t.online
          studio. Its own section and Save (rows behind its own route), shown
          only there; a Glofox studio sells nothing through Mia. */}
      {membershipSourceKey === 'un1t_online' && location?.id && (
        <MiaOffersSection locationId={location.id} canEdit={canEdit} />
      )}

      {/* ── Membership cancellation form (CANCEL-FORM.2) ───── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <h2 className="text-base font-semibold text-un1t-text mb-1">Membership cancellation form</h2>
        <p className="text-sm text-un1t-muted mb-4">
          Staff send a member a private, single-use link (by email or WhatsApp) to pause or cancel
          their membership. Submissions land in Approvals like any other request. Every word the member
          sees is editable here; leave a field blank to use the default shown. Placeholders:{' '}
          <code>{'{first_name}'}</code> <code>{'{plan}'}</code> <code>{'{location}'}</code>{' '}
          <code>{'{link}'}</code> <code>{'{end_date}'}</code> <code>{'{start_date}'}</code>.
        </p>

        {renderField('glofox_auto_cancel', { className: 'mb-4' })}

        <h3 className="text-sm font-semibold text-un1t-text mt-4 mb-2">The form page</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Intro</label>
            <textarea className={inputCls} rows={2} maxLength={1000} value={settings.cancellation_form?.form_intro || ''}
              onChange={e => setCancelForm('form_intro', e.target.value)}
              placeholder={CF_DEFAULTS.form_intro} />
          </div>
          <label className="flex items-center gap-2 text-sm text-un1t-text">
            <input type="checkbox" checked={settings.cancellation_form?.pause_offer_enabled !== false}
              onChange={e => setCancelForm('pause_offer_enabled', e.target.checked)} />
            Offer a pause before the cancel details
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Pause offer text</label>
              <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.pause_offer_text || ''}
                onChange={e => setCancelForm('pause_offer_text', e.target.value)}
                placeholder={CF_DEFAULTS.pause_offer_text} />
            </div>
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Longest pause (weeks)</label>
              <input type="number" min={1} max={26} className={inputCls}
                value={settings.cancellation_form?.pause_max_weeks ?? ''}
                placeholder={String(CF_DEFAULTS.pause_max_weeks)}
                onChange={e => setCancelForm('pause_max_weeks', e.target.value === '' ? null : Number(e.target.value))} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Reason options (shown as the member&apos;s choices)</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {CF_REASON_CODES.map(code => (
                <input key={code} className={inputCls} maxLength={80}
                  value={settings.cancellation_form?.reason_labels?.[code] || ''}
                  onChange={e => setCancelReason(code, e.target.value)}
                  placeholder={CF_DEFAULTS.reason_labels[code]} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">End date help text</label>
              <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.end_date_help_text || ''}
                onChange={e => setCancelForm('end_date_help_text', e.target.value)}
                placeholder={CF_DEFAULTS.end_date_help_text} />
            </div>
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Notice period (days)</label>
              <input type="number" min={0} max={90} className={inputCls}
                value={settings.cancellation_form?.notice_days ?? ''}
                placeholder={String(CF_DEFAULTS.notice_days)}
                onChange={e => setCancelForm('notice_days', e.target.value === '' ? null : Number(e.target.value))} />
              <p className="text-xs text-un1t-subtle mt-1">The earliest end date the member can pick is this many days from today.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Review step text</label>
            <input className={inputCls} maxLength={500} value={settings.cancellation_form?.confirm_text || ''}
              onChange={e => setCancelForm('confirm_text', e.target.value)}
              placeholder={CF_DEFAULTS.confirm_text} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Thanks (cancellation submitted)</label>
              <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.thanks_cancel_text || ''}
                onChange={e => setCancelForm('thanks_cancel_text', e.target.value)}
                placeholder={CF_DEFAULTS.thanks_cancel_text} />
            </div>
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Thanks (pause submitted)</label>
              <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.thanks_pause_text || ''}
                onChange={e => setCancelForm('thanks_pause_text', e.target.value)}
                placeholder={CF_DEFAULTS.thanks_pause_text} />
            </div>
          </div>
        </div>

        <h3 className="text-sm font-semibold text-un1t-text mt-6 mb-2">Sending the link</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Email subject</label>
            <input className={inputCls} maxLength={200} value={settings.cancellation_form?.email_subject || ''}
              onChange={e => setCancelForm('email_subject', e.target.value)}
              placeholder={CF_DEFAULTS.email_subject} />
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Email body (must include <code>{'{link}'}</code>)</label>
            <textarea className={inputCls} rows={5} maxLength={4000} value={settings.cancellation_form?.email_body || ''}
              onChange={e => setCancelForm('email_body', e.target.value)}
              placeholder={CF_DEFAULTS.email_body} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-un1t-text mb-1">WhatsApp message (the link becomes a tappable button)</label>
              <textarea className={inputCls} rows={3} maxLength={1024} value={settings.cancellation_form?.whatsapp_text || ''}
                onChange={e => setCancelForm('whatsapp_text', e.target.value)}
                placeholder={CF_DEFAULTS.whatsapp_text} />
            </div>
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Button label</label>
              <input className={inputCls} maxLength={20} value={settings.cancellation_form?.whatsapp_button_text || ''}
                onChange={e => setCancelForm('whatsapp_button_text', e.target.value)}
                placeholder={CF_DEFAULTS.whatsapp_button_text} />
              <p className="text-xs text-un1t-subtle mt-1">20 characters max (WhatsApp&apos;s limit).</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Outside-window WhatsApp template</label>
              <select className={inputCls}
                value={settings.cancellation_form?.whatsapp_template_name || ''}
                onChange={e => setCancelForm('whatsapp_template_name', e.target.value || null)}>
                <option value="">— none (send by WhatsApp only inside the 24h window) —</option>
                {templates.map(t => (
                  <option key={`${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
                ))}
              </select>
              <p className="text-xs text-un1t-subtle mt-1">
                An approved UTILITY template whose URL button ends in <code>{'{{1}}'}</code> (the link token) —
                lets staff send the form when the member has not messaged in 24 hours.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-un1t-text mb-1">Link host (optional)</label>
              <input className={inputCls} maxLength={512} value={settings.cancellation_form?.public_base_url || ''}
                onChange={e => setCancelForm('public_base_url', e.target.value)}
                placeholder="Default: this CRM's address" />
              <p className="text-xs text-un1t-subtle mt-1">
                e.g. <code>https://un1tdublin.com</code> to hand members a link on the marketing site instead of the CRM address.
              </p>
            </div>
          </div>
        </div>

        <h3 className="text-sm font-semibold text-un1t-text mt-6 mb-2">After you decide</h3>
        <p className="text-xs text-un1t-muted mb-3">Sent to the member on the channel the link went out on (email, or the WhatsApp thread).</p>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Cancellation approved</label>
            <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.cancel_confirmation_text || ''}
              onChange={e => setCancelForm('cancel_confirmation_text', e.target.value)}
              placeholder={CF_DEFAULTS.cancel_confirmation_text} />
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Pause approved</label>
            <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.pause_confirmation_text || ''}
              onChange={e => setCancelForm('pause_confirmation_text', e.target.value)}
              placeholder={CF_DEFAULTS.pause_confirmation_text} />
          </div>
          <div>
            <label className="block text-sm font-medium text-un1t-text mb-1">Marked as saved (member stays)</label>
            <textarea className={inputCls} rows={2} maxLength={500} value={settings.cancellation_form?.saved_confirmation_text || ''}
              onChange={e => setCancelForm('saved_confirmation_text', e.target.value)}
              placeholder={CF_DEFAULTS.saved_confirmation_text} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[['confirmation_template_cancel', 'Cancellation template'], ['confirmation_template_pause', 'Pause template'], ['confirmation_template_saved', 'Saved template']].map(([key, label]) => (
              <div key={key}>
                <label className="block text-sm font-medium text-un1t-text mb-1">{label} (WhatsApp, window closed)</label>
                <select className={inputCls}
                  value={settings.cancellation_form?.[key] || ''}
                  onChange={e => setCancelForm(key, e.target.value || null)}>
                  <option value="">— none —</option>
                  {templates.map(t => (
                    <option key={`${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <p className="text-xs text-un1t-subtle">
            A WhatsApp-delivered form rarely reopens the 24h window, so without a template the card tells you the member has not been told and you follow up yourself.
            Templates take <code>{'{{1}}'}</code> first name and <code>{'{{2}}'}</code> the date.
          </p>
        </div>

        {canEdit && (
          <div className="mt-5">
            <button type="button" onClick={saveSettings} disabled={saving || quietHalf || trialInvalid}
              className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50">
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            {savedAt && <span className="ml-3 text-sm text-green-600">Saved ✓</span>}
          </div>
        )}
      </section>

      {/* ── Proactive follow-ups (AGENT-FOLLOWUP.1) ───────── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <h2 className="text-base font-semibold text-un1t-text mb-1">Proactive follow-ups</h2>
        <p className="text-sm text-un1t-muted mb-4">
          When someone goes quiet on an open request, the agent sends one gentle in-window nudge,
          then (if they stay quiet past WhatsApp&apos;s 24-hour window) one approved template inviting
          a reply. A reply re-opens the window and the agent picks the conversation back up.
        </p>
        {renderField('followups.enabled', { className: 'mb-4' })}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {renderField('followups.nudge_after_hours')}
          <div>
            <FieldLabel tag={tagFor(['followups.template_name'])}>Outside-window template</FieldLabel>
            <select className={inputCls}
              value={settings.followups?.template_name || ''}
              onChange={e => setFollowup('template_name', e.target.value || null)}>
              <option value="">— none (in-window nudge only) —</option>
              {templates.map(t => (
                <option key={`${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
              ))}
            </select>
            <p className="text-xs text-un1t-subtle mt-1">
              Approved templates only. Edit the wording in WhatsApp → Templates and re-select here —
              variables: {'{{1}}'} first name, {'{{2}}'} topic. Marketing consent is required and enforced.
            </p>
          </div>
          {renderField('followups.daily_cap')}
        </div>
      </section>

      {/* ── First-class check-in (AGENT-CHECKIN.1) ────────── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <h2 className="text-base font-semibold text-un1t-text mb-1">First-class check-in</h2>
        <p className="text-sm text-un1t-muted mb-4">
          After a new lead or trial member attends their first class, the agent checks in once —
          free-form when they have an open chat window (e.g. they booked through the agent), or via
          the approved template below otherwise. Good replies get offered their next booking;
          complaints hand off to the team immediately.
        </p>
        {renderField('first_class_checkin.enabled', { className: 'mb-4' })}
        {/* AGENT-CHECKIN.2 — live visibility so a silent day is diagnosable
            from this card (sent counts, last outcome, last tick's skips). */}
        {checkinStats && (
          <div className="mb-4 rounded-md border border-un1t-border bg-un1t-bg/40 px-3 py-2 text-xs text-un1t-subtle space-y-1">
            <p>
              {/* CHECKINRISKS.1 — both counts are SENDS (the cap's own counter);
                  null means the read failed, which is never shown as 0. */}
              <span className="font-semibold text-un1t-text">
                {checkinStats.sent_today == null
                  ? 'Sent today: could not be read'
                  : `Sent today ${checkinStats.sent_today}/${settings.first_class_checkin?.daily_cap ?? 20}`}
              </span>
              {' · '}Sent all time {checkinStats.total == null ? 'could not be read' : checkinStats.total}
              {' · '}Last:{' '}
              {checkinStats.last_unreadable
                ? 'could not be read'
                : checkinStats.last
                  ? `${checkinStats.last.contact_name || 'contact'} — ${checkinStats.last.note || 'sent'} (${new Date(checkinStats.last.at).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`
                  : 'none yet'}
            </p>
            {checkinStats.last_run && (
              <p>
                Last run {new Date(checkinStats.last_run.at).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
                {checkinStats.last_run.checkins
                  ? ` — ${(checkinStats.last_run.checkins.freeform || 0) + (checkinStats.last_run.checkins.templates || 0)} sent · ${checkinStats.last_run.checkins.skipped || 0} skipped${describeCheckinReasons(checkinStats.last_run.checkins)}`
                  // TZ.16 — the window is the studio's own clock (TZ.5): name its zone.
                  : ` — no check-in summary yet (runs every 15 min, 9:00–20:00 ${location?.timezone ? zoneCity(location.timezone) : 'studio time'})`}
              </p>
            )}
            {checkinStats.last_run?.day && (
              <p>{describeCheckinDay(checkinStats.last_run.day)}</p>
            )}
            {checkinStats.last_run?.day?.previous && (
              <p>{describeCheckinDay(checkinStats.last_run.day.previous)}</p>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {renderField('first_class_checkin.delay_hours')}
          <div>
            <FieldLabel tag={tagFor(['first_class_checkin.template_name'])}>Check-in template</FieldLabel>
            <select className={inputCls}
              value={settings.first_class_checkin?.template_name || ''}
              onChange={e => setCheckin('template_name', e.target.value || null)}>
              <option value="">— none (open-window check-ins only) —</option>
              {templates.map(t => (
                <option key={`fcc:${t.name}:${t.language}`} value={t.name}>{t.name} ({t.language})</option>
              ))}
            </select>
            <p className="text-xs text-un1t-subtle mt-1">
              Used when they have no open chat window. Variables: {'{{1}}'} first name, {'{{2}}'} class name.
              Marketing consent required and enforced.
            </p>
          </div>
          {renderField('first_class_checkin.daily_cap')}
        </div>
      </section>

      {/* ── Trial finisher follow-up (TRIALDONE.3) ────────────
          Studio-only (an organisation can never switch it on) and shown only
          at a un1t.online studio (Hatch Street). After a trial member's last
          class the studio sends the opener template below; a reply goes to
          Mia, briefed by the instruction. Off by default. A list of test
          contacts makes it a test: nobody else is messaged. */}
      {showTrialDone && settings.trial_done && (() => {
        const td = settings.trial_done
        const idsText = td.only_contact_ids_text ?? (Array.isArray(td.only_contact_ids) ? td.only_contact_ids : []).join('\n')
        const testCount = parseTrialDoneContactIds(idsText).length
        return (
          <section className="border border-un1t-border rounded-lg p-5 mt-6" data-testid="trial-done-card">
            <h2 className="text-base font-semibold text-un1t-text mb-1">Trial finisher follow-up</h2>
            <p className="text-sm text-un1t-muted mb-4">
              After a trial member has done 3 trial classes, or 2 classes and the trial has expired, the studio
              sends them the opener template below. If they reply, Mia helps them choose between a membership and a class pack
              and sends the payment link. A second message follows if they stay quiet.
            </p>
            <div className="flex items-center justify-between gap-2 mb-4">
              <label className="flex items-center gap-2 text-sm text-un1t-text">
                <input type="checkbox" checked={!!td.enabled}
                  onChange={e => setTrialDone('enabled', e.target.checked)} />
                Enable trial finisher follow-up
              </label>
              {testCount > 0 && (
                <span className="text-[11px] rounded-full bg-amber-500/10 text-amber-700 px-2 py-0.5 whitespace-nowrap">
                  {`Test: ${testCount} contact${testCount === 1 ? '' : 's'} only`}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <FieldLabel>Opener template</FieldLabel>
                <input className={inputCls} maxLength={512} aria-label="Opener template"
                  value={td.opener_template ?? ''}
                  aria-invalid={trialErrors.opener_template ? 'true' : undefined}
                  onChange={e => setTrialDone('opener_template', e.target.value)} />
                {trialErrors.opener_template
                  ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.opener_template}</p>
                  : <p className="text-xs text-un1t-subtle mt-1">The approved WhatsApp template name sent first. Variables: {'{{1}}'} first name.</p>}
              </div>
              <div>
                <FieldLabel>Follow-up template</FieldLabel>
                <input className={inputCls} maxLength={512} aria-label="Follow-up template"
                  value={td.followup_template ?? ''}
                  aria-invalid={trialErrors.followup_template ? 'true' : undefined}
                  onChange={e => setTrialDone('followup_template', e.target.value)} />
                {trialErrors.followup_template
                  ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.followup_template}</p>
                  : <p className="text-xs text-un1t-subtle mt-1">The approved template name sent once if they have not replied.</p>}
              </div>
              <div>
                <FieldLabel>Send after (hours)</FieldLabel>
                <input type="number" min={1} max={72} className={inputCls} aria-label="Send after (hours)"
                  value={td.delay_hours ?? ''}
                  placeholder="2"
                  aria-invalid={trialErrors.delay_hours ? 'true' : undefined}
                  onChange={e => setTrialDone('delay_hours', e.target.value === '' ? null : Number(e.target.value))} />
                {trialErrors.delay_hours
                  ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.delay_hours}</p>
                  : <p className="text-xs text-un1t-subtle mt-1">Hours after the trial ends before the opener goes out.</p>}
              </div>
            </div>
            <div className="mt-4">
              <FieldLabel>Mia&apos;s instruction</FieldLabel>
              <textarea className={inputCls} rows={4} aria-label="Mia's instruction"
                value={td.mia_instruction ?? ''}
                placeholder={TRIAL_DONE_MIA_INSTRUCTION_DEFAULT}
                aria-invalid={trialErrors.mia_instruction ? 'true' : undefined}
                onChange={e => setTrialDone('mia_instruction', e.target.value)} />
              {trialErrors.mia_instruction
                ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.mia_instruction}</p>
                : <p className="text-xs text-un1t-subtle mt-1">What Mia is told when a trial finisher replies. Leave blank for the default shown. Placeholders: {'{studio}'} {'{date}'}. No em-dashes.</p>}
            </div>
            <div className="mt-4">
              <FieldLabel>Test contact ids</FieldLabel>
              <textarea className={inputCls} rows={2} aria-label="Test contact ids"
                value={idsText}
                aria-invalid={trialErrors.only_contact_ids ? 'true' : undefined}
                onChange={e => setTrialDone('only_contact_ids_text', e.target.value)} />
              {trialErrors.only_contact_ids
                ? <p className="text-xs text-red-600 mt-1" role="alert">{trialErrors.only_contact_ids}</p>
                : <p className="text-xs text-un1t-subtle mt-1">
                    Up to 20 contact ids, one per line. While this list has anyone in it, ONLY those contacts are messaged: use it to test before clearing it to go live for everyone.
                  </p>}
            </div>
          </section>
        )
      })()}

      {/* ── Inline suggestion after approvals (INBOX-APPROVALS-AI.4) ── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <h2 className="text-base font-semibold text-un1t-text mb-1">Inline suggestion after approvals</h2>
        <p className="text-sm text-un1t-muted mb-4">
          After staff decide a request in the inbox, Mia drafts a suggested follow-up they can send.
        </p>
        {renderField('inline_suggestion.enabled')}
      </section>

      </fieldset>

      {/* ── Knowledge ─────────────────────────────────────── */}
      <section className="border border-un1t-border rounded-lg p-5 mt-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-un1t-text">Knowledge</h2>
          <div className="flex items-center gap-2">
            <button type="button" onClick={importFromGlofox} disabled={importing}
              className="text-sm border border-un1t-border rounded-md px-3 py-1.5 text-un1t-text hover:bg-un1t-bg disabled:opacity-50">
              {importing ? 'Importing…' : 'Import classes from Glofox'}
            </button>
            <button type="button" onClick={addEntry}
              className="text-sm border border-un1t-border rounded-md px-3 py-1.5 text-un1t-text hover:bg-un1t-bg">
              + Add entry
            </button>
          </div>
        </div>
        <p className="text-sm text-un1t-muted mb-4">
          The facts the agent is allowed to use — prices, offers, policies, FAQs. If it isn&apos;t here,
          the agent hands off instead of guessing.
        </p>
        {importNote && <p className="text-sm text-emerald-700 mb-3">{importNote}</p>}

        {entries.length === 0 && (
          <div className="text-sm text-un1t-muted border border-dashed border-un1t-border rounded-md p-4">
            No knowledge yet. Add your prices, trial offer, opening hours, and common questions.
          </div>
        )}

        <div className="space-y-3">
          {entries.map(entry => (
            <div key={entry.id} className="border border-un1t-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <select value={entry.category}
                  onChange={e => persist(entry.id, { category: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text">
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-sm text-un1t-text"
                  value={entry.title}
                  onChange={e => editLocal(entry.id, { title: e.target.value })}
                  onBlur={e => persist(entry.id, { title: e.target.value })}
                  placeholder="Short title" maxLength={200} />
                <label className="flex items-center gap-1 text-xs text-un1t-muted">
                  <input type="checkbox" checked={!!entry.enabled}
                    onChange={e => persist(entry.id, { enabled: e.target.checked })} />
                  on
                </label>
                <button onClick={() => deleteEntry(entry.id)}
                  className="text-xs text-red-600 hover:underline">Delete</button>
              </div>
              <textarea className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                rows={2} maxLength={4000} value={entry.content}
                onChange={e => editLocal(entry.id, { content: e.target.value })}
                onBlur={e => persist(entry.id, { content: e.target.value })}
                placeholder="The answer / fact, in plain language." />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
