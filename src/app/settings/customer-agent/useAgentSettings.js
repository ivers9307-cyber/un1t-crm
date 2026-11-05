'use client'

// MIASETTINGS.2a — every piece of the studio's Mia settings state in one hook:
// the load, the edits and their override bookkeeping, the unsaved-change list,
// Discard, Save and the three holds. Moved out of CustomerAgentClient with the
// same behaviour (load, save and refresh are today's, line for line). The
// knowledge editor keeps its own state: it saves as you go.
//
// `canEdit` only decides whether a source tag offers the way back; the PUT is
// what enforces it, and the page hides Save for a non-owner.

import { useState, useEffect, useRef } from 'react'
// MIAORG.1 Task 3 — which fields this studio sets itself (zod-free, shared
// with the PUT's contract).
import {
  initialOverridden, withOverride, withoutOverride, valueAt, fieldSource, orgSetsAny,
  isOverridden, INHERITABLE_SCALAR_KEYS, INHERITABLE_OBJECT_KEYS, INHERITABLE_OBJECT_FIELDS, isHalfQuietWindow,
} from '@/lib/agent/settings-overrides'
import {
  buildSavePayload, bookingLinkErrors, bookingIssuesFromResponse, trialDoneErrors,
} from './save-payload'
import { changedPaths, dirtySections as sectionsOf } from './dirty'
import SourceTag from './components/SourceTag'

const SETTINGS_URL = '/api/settings/customer-agent'
const NO_BRAND = { companyName: '', shortName: '' }

// The fields whose edits are never an override: the trial finisher and the
// cancellation form are studio-only blocks, always saved whole.
const NO_OVERRIDE_KEYS = new Set(['trial_done', 'cancellation_form'])

// `obj` with `value` at a dotted path, copying each object on the way down.
function setIn(obj, path, value) {
  const dot = path.indexOf('.')
  if (dot < 0) return { ...obj, [path]: value }
  const key = path.slice(0, dot)
  return { ...obj, [key]: setIn(obj?.[key] || {}, path.slice(dot + 1), value) }
}

const snapshotOf = (settings, overridden) => ({ settings: structuredClone(settings), overridden: [...overridden] })

// What an organisation save changes in a settings object: every inheritable
// field `overridden` does not hold shows its new inherited value. Applied to
// the screen (with the screen's overrides) and to the snapshot (with the
// snapshot's), so an unsaved studio edit stays an unsaved edit.
function withInherited(s, overridden, nextInherited) {
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
}

export function useAgentSettings({ canEdit = false } = {}) {
  const [settings, setSettings] = useState(null)
  const [location, setLocation] = useState(null)
  // W1.S3 — the studio's resolved brand (GET payload), for the placeholders.
  const [brand, setBrand] = useState(NO_BRAND)
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
  // MIASETTINGS.2a — { settings, overridden } as last loaded or saved: what
  // "unsaved" is measured against, and what Discard puts back.
  const [snapshot, setSnapshot] = useState(null)

  // After a load or a save's re-read: the whole studio state, and a new snapshot.
  function applySettingsResponse(sRes) {
    const nextOverridden = initialOverridden(sRes.studio)
    setSettings(sRes.settings); setLocation(sRes.location || null); setCheckinStats(sRes.checkin_stats || null)
    setBrand(sRes.brand || NO_BRAND)
    setOverridden(nextOverridden)
    setOrg(sRes.org || null)
    setInherited(sRes.inherited || null)
    setBookings(typeof sRes.bookings === 'boolean' ? sRes.bookings : null)
    setMembershipSourceKey(typeof sRes.membership_source_key === 'string' ? sRes.membership_source_key : null)
    setSnapshot(snapshotOf(sRes.settings, nextOverridden))
  }

  async function load(isCancelled = () => false) {
    try {
      const sRes = await fetch(SETTINGS_URL).then(r => r.json())
      if (isCancelled()) return
      if (sRes?.success && sRes.settings) {
        applySettingsResponse(sRes)
        setLoadFailed(false)
      } else {
        setSettings(null); setLoadFailed(true)
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // AGENT-FOLLOWUP.1 — approved templates for the template pickers. The
  // template COPY lives in the WhatsApp Templates manager (edit & resubmit
  // there any time); a picker just selects which one is used.
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

  // One field's edit, by its settings path: a plain key ('tone'), one field of
  // an object key ('followups.daily_cap', overridden per field), or deeper
  // ('cancellation_form.reason_labels.price'). Editing an inheritable field
  // makes it this studio's own (studio-only keys are ignored by withOverride:
  // they are always saved). The trial finisher and the cancellation form take
  // no override bookkeeping at all. A PUT error on the field is cleared.
  function setField(path, value) {
    setSettings(s => setIn(s, path, value))
    const key = path.split('.')[0]
    if (!NO_OVERRIDE_KEYS.has(key)) setOverridden(o => withOverride(o, path))
    setServerFieldErrors(e => (path in e ? Object.fromEntries(Object.entries(e).filter(([f]) => f !== path)) : e))
  }

  // Quiet hours are a pair: editing either end makes both the studio's own
  // (and ends a "no quiet hours" opt-out).
  function setQuietHours(end, value) {
    setSettings(s => {
      const { off: _off, ...q } = s.quiet_hours || {}
      return { ...s, quiet_hours: { ...q, [end]: value } }
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

  // The tag beside an inheritable field's label (staff copy, T3-F). A whole
  // object key (quiet_hours) counts as set at the organisation only on a set FIELD.
  function sourceTag(paths) {
    return (
      <SourceTag source={fieldSource(paths, { overridden, org })} canEdit={canEdit}
        orgHas={orgSetsAny(paths, org)} onRevert={() => revertToInherited(paths)} />
    )
  }

  // MIAORG.1 Task 3 — after a save, re-read so every tag and value shows the
  // truth (a field cleared to blank is "not set here" and inherits again).
  // Settings only: a knowledge edit in progress is never overwritten. A failed
  // re-read keeps what is on screen (the save itself succeeded). True when
  // the re-read landed.
  async function refreshSettings() {
    try {
      const sRes = await fetch(SETTINGS_URL).then(r => r.json())
      if (sRes?.success && sRes.settings) { applySettingsResponse(sRes); return true }
    } catch { /* keep the edited state; the save went through */ }
    return false
  }

  async function save() {
    // SETTINGSWIPE.1 — nothing loaded, nothing to save.
    if (loadFailed || !settings) return
    setSaving(true); setError(null)
    try {
      // MIAORG.1 Task 3 — pure (./save-payload.js), so the round trip test
      // runs this exact body.
      const payload = buildSavePayload(settings, overridden)
      const res = await fetch(SETTINGS_URL, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (j.success) {
        setSavedAt(Date.now()); setServerFieldErrors({})
        // The re-read sets the snapshot; if it fails, what was sent is what is saved.
        if (!(await refreshSettings())) setSnapshot(snapshotOf(settings, overridden))
      } else {
        setServerFieldErrors(bookingIssuesFromResponse(j.issues))
        setError(j.error || 'Failed to save')
      }
    } catch { setError('Failed to save') } finally { setSaving(false) }
  }

  // MIASETTINGS.2a — put back what was last loaded or saved.
  function discard() {
    if (!snapshot) return
    setSettings(structuredClone(snapshot.settings))
    setOverridden([...snapshot.overridden])
    setServerFieldErrors({})
    setError(null)
  }

  // MIAORG.1 Task 4 — after an ORGANISATION save: re-read what this studio
  // inherits and show it in every field the studio does not set, without
  // touching the studio's own (possibly unsaved) edits. The snapshot takes
  // the same new inherited values for the fields IT does not override, so an
  // unsaved edit stays unsaved and an untouched field does not turn dirty.
  async function refreshInherited() {
    try {
      const sRes = await fetch(SETTINGS_URL).then(r => r.json())
      if (!sRes?.success || !sRes.settings) return
      const nextInherited = sRes.inherited || null
      setOrg(sRes.org || null)
      setInherited(nextInherited)
      // Read when React applies the update, so an edit made while the org
      // save was in flight keeps the operator's value.
      setSettings(s => (s ? withInherited(s, overriddenRef.current, nextInherited) : s))
      setSnapshot(snap => (snap?.settings
        ? { ...snap, settings: withInherited(snap.settings, snap.overridden, nextInherited) }
        : snap))
    } catch { /* the org save went through; this studio's screen keeps what it shows */ }
  }

  const dirtyPaths = settings && snapshot ? changedPaths(snapshot, { settings, overridden }) : []

  // The three checks that hold Save (as the PUT checks them), each naming its
  // section. Booking link: shown at a studio whose membership source takes no
  // bookings, and at a un1t.online studio (MIAHATCH.4, the fallback link).
  // Trial finisher: a un1t.online studio only (TRIALDONE.3).
  const holds = []
  if (settings) {
    if (isHalfQuietWindow(settings.quiet_hours)) holds.push({ section: 'overview', message: 'Set both quiet hours times' })
    const showBookingLink = bookings !== true || membershipSourceKey === 'un1t_online'
    const linkError = Object.values(bookingLinkErrors(settings))[0]
    if (showBookingLink && linkError) holds.push({ section: 'bookings', message: linkError })
    const trialError = membershipSourceKey === 'un1t_online' ? Object.values(trialDoneErrors(settings))[0] : null
    if (trialError) holds.push({ section: 'followups', message: trialError })
  }

  const ctx = { membershipSourceKey, bookings, brand, agentName: settings?.agent_name }

  return {
    // `saved`: the settings as last loaded or saved (the header's status and
    // quiet-hours tags show these, never unsaved edits).
    loading, loadFailed, reload: () => load(), settings, saved: snapshot?.settings ?? null, overridden, org, inherited, location, brand, bookings,
    membershipSourceKey, checkinStats, templates, ctx,
    setField, setQuietHours, setNoQuietHours, revertToInherited, sourceTag, inheritedNumber,
    dirtyPaths, dirtySections: sectionsOf(dirtyPaths), holds,
    saving, savedAt, error, serverFieldErrors, save, discard, refreshInherited,
  }
}
