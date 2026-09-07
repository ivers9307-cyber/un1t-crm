'use client'

// HOST-EMAIL.3/.4 — the host portal's "Email your contacts" surface.
//
// .4 upgrades the composer to parity with the CRM communications editor:
//   - the same Unlayer visual designer (design + plain-text modes; the
//     design document round-trips via host_campaigns.design_json so drafts
//     reopen editable), and
//   - an audience picker: everyone, or confirmed attendees of ONE of the
//     host's events (resolved from registrations server-side at send time).
//
// The server still owns every send gate (verified sender, daily cap,
// consent/suppression, double-send CAS) and its 409 messages are
// user-facing, so they render inline verbatim. The unsubscribe footer is
// injected server-side after sanitization — nothing here can omit it.
//
// HOST-METRICS.1 — a sent/sending row's subject links to its report
// (HostEmailReport, at /host/emails/[id]) and the subline swaps in the
// per-send stats once the list API reports them.
//
// Dark UN1T host-portal styling (bg-black page) — dark-surface chip recipe
// `bg-<c>-500/15 text-<c>-300`; host paths are exempt from the light-theme
// -700 chip rule.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  nextQuarterHour, isoToDublinInputs, dublinLocalToIso, dublinScheduleLabel, scheduleErrorCopy, TIME_OPTIONS,
} from '@/lib/host-schedule-time'
import HostEmailPreviewModal from './HostEmailPreviewModal.jsx'

/**
 * Request body for a test send. A blank or cancelled prompt yields {} so the
 * route falls back to the host session's own email; an empty `to` would 400.
 * @param {string|null} answer  raw window.prompt result
 */
export function buildTestSendBody(answer) {
  const trimmed = (answer || '').trim()
  return trimmed ? { to: trimmed } : {}
}

/**
 * The list-row subline once a send has stats: "124 sent · 118 delivered ·
 * 41 opened · 9 clicked". Returns null (not a string) when stats are
 * absent — old rows, or a campaign predating HOST-METRICS.1 — so the caller
 * falls back to the coarser sent/recipient_count line.
 * @param {object|undefined} stats
 */
export function statsLine(stats) {
  if (!stats) return null
  const { sent = 0, delivered = 0, opened = 0, clicked = 0 } = stats
  return `${sent} sent · ${delivered} delivered · ${opened} opened · ${clicked} clicked`
}

/**
 * The list row's one-line status, per campaign state (HOST-SCHEDULE.1):
 * a scheduled row shows its Dublin fire time; a draft the sweeper refused
 * shows the reason in plain words; anything sent keeps the stats line.
 * @param {object} c  campaign row from GET /api/host/emails
 */
export function rowSubline(c) {
  if (c.status === 'scheduled') return `Scheduled for ${dublinScheduleLabel(c.scheduled_for)}`
  if (c.status === 'draft') {
    return c.schedule_error
      ? `Not sent. ${scheduleErrorCopy(c.schedule_error)}. Schedule it again or send it now.`
      : 'Not sent yet'
  }
  if (c.status === 'sending' && c.paused_reason) return `Paused. ${scheduleErrorCopy(c.paused_reason)}. Ask UN1T.`
  return statsLine(c.stats) || `${c.sent_count || 0}/${c.recipient_count ?? '—'} sent`
}

/** HOST-EMAILS.2 — fixed audience line for a reminder draft; '' otherwise. */
export function audienceSummary(c, campaignsById) {
  if (c?.audience_kind !== 'non_openers') return ''
  const parent = campaignsById?.get(c.audience_campaign_id)
  return parent?.subject ? `People who didn't open '${parent.subject}'` : "People who didn't open the original email"
}

/** The Send confirm text, per audience kind. */
export function sendConfirmCopy(c, audienceLabelText, campaignsById) {
  const typeNote = c?.email_type === 'utility' ? ' as a UTILITY email (reaches attendees regardless of marketing opt-in)' : ''
  if (c?.audience_kind === 'non_openers') return `Send this email to ${audienceSummary(c, campaignsById).replace(/^People/, 'people')}${typeNote}?`
  return `Send this email to ${audienceLabelText}${typeNote}?`
}

/**
 * What the schedule panel opens on: the row's own time when rescheduling,
 * else the next quarter hour at least 15 minutes out.
 * @param {object} c
 * @param {number} [nowMs=Date.now()]
 */
export function schedulePanelDefaults(c, nowMs = Date.now()) {
  return (c?.scheduled_for && isoToDublinInputs(c.scheduled_for)) || nextQuarterHour(nowMs)
}

/**
 * Which row actions a campaign's status permits: a `sending` row is mid-send
 * and offers neither; `draft`/`scheduled` rows (still editable) offer both;
 * anything else (`sent`, `failed`) offers Duplicate only — there's no draft
 * left to delete.
 * @param {string} status
 */
export function rowActions(status) {
  if (status === 'sending') return { duplicate: false, delete: false }
  if (status === 'draft' || status === 'scheduled') return { duplicate: true, delete: true }
  return { duplicate: true, delete: false }
}

/**
 * HOST-EMAILS.2 — the whole design-mode decision `editDraft` makes when a
 * draft is opened, as one pure function so it can be tested (and so the
 * text-only branch can never again forget to clear state the designed
 * branch set).
 *
 * A designed draft ALWAYS opens in design mode. If the editor is up the
 * design loads immediately (`loadNow`); if it is not, the design waits in
 * `pendingDesign` and the composer says so. A draft with no design opens in
 * text mode with everything design-shaped cleared — pending design included,
 * because a stale pending design from a PREVIOUS draft would otherwise be
 * loaded into this one the moment the designer initialised, and a save would
 * then write the previous draft's design onto this one.
 *
 * @param {object|null} draft                   campaign row from GET /api/host/emails/[id]
 * @param {object}      [opts]
 * @param {boolean}     [opts.editorInited]     has window.unlayer.init() already run?
 * @param {boolean}     [opts.unlayerReady]     is the Unlayer script up (window.unlayer present)?
 * @param {string}      [opts.previousNotice]   current designerNotice ('' | 'loading' | 'failed')
 * @returns {{ mode: 'design'|'text', pendingDesign: object|null, notice: ''|'loading'|'failed', hasDesign: boolean, loadNow: boolean }}
 */
export function designStateForDraft(draft, { editorInited = false, unlayerReady = false, previousNotice = '' } = {}) {
  const design = draft?.design_json || null
  if (!design) return { mode: 'text', pendingDesign: null, notice: '', hasDesign: false, loadNow: false }
  const loadNow = Boolean(editorInited) && Boolean(unlayerReady)
  return {
    mode: 'design',
    pendingDesign: loadNow ? null : design,
    // A designer that already failed to load stays failed: telling the host
    // it is "loading" when the script is never coming would be a lie.
    notice: loadNow ? '' : (previousNotice === 'failed' ? 'failed' : 'loading'),
    hasDesign: true,
    loadNow,
  }
}

const STATUS_CHIP = {
  draft: 'bg-white/10 text-white/70',
  scheduled: 'bg-sky-500/15 text-sky-300',
  sending: 'bg-amber-500/15 text-amber-300',
  sent: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}

const STATUS_LABEL = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
}

const UNLAYER_SRC = 'https://editor.unlayer.com/embed.js'
const EDITOR_DIV_ID = 'host-email-designer'
// How long to wait for the embed script before telling the host it failed.
const UNLAYER_LOAD_TIMEOUT_MS = 15000

export default function HostEmails() {
  const [campaigns, setCampaigns] = useState(null) // null = loading
  const [audiences, setAudiences] = useState({ all_count: null, mailing_list_count: null, events: [] })
  const [subject, setSubject] = useState('')
  const [audienceEventId, setAudienceEventId] = useState('')
  const [emailType, setEmailType] = useState('marketing')
  const [mode, setMode] = useState('design') // 'design' | 'text'
  const [textBody, setTextBody] = useState('')
  const [editingId, setEditingId] = useState(null) // draft being edited (null = new)
  const [unlayerReady, setUnlayerReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sendingId, setSendingId] = useState(null)
  const [testingId, setTestingId] = useState(null)
  const [lastTestEmail, setLastTestEmail] = useState('')
  const [loadingDraftId, setLoadingDraftId] = useState(null)
  const [schedulingId, setSchedulingId] = useState(null) // row whose schedule panel is open
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduleBusy, setScheduleBusy] = useState(false)
  const [schedulingBusyId, setSchedulingBusyId] = useState(null) // row whose Cancel/Edit/Change-time is mid-request
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const editorInited = useRef(false)
  // HOST-EMAILS.2 — reminder-draft audience, "designed draft waits for the
  // designer" state, preview-as-sent modal, and delete/duplicate row state.
  const [audienceCampaignId, setAudienceCampaignId] = useState(null) // parent id when editing a reminder draft, else null
  const pendingDesignRef = useRef(null)
  const [designerNotice, setDesignerNotice] = useState('') // '' | 'loading' | 'failed'
  const [designDropped, setDesignDropped] = useState(false)
  const [hasDesign, setHasDesign] = useState(false) // does the draft being edited actually carry a design_json?
  const [preview, setPreview] = useState(null) // { html, width } or null
  const [previewBusy, setPreviewBusy] = useState(false)
  const [rowBusyId, setRowBusyId] = useState(null) // delete/duplicate in flight
  const searchParams = useSearchParams()

  const campaignsById = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/host/emails', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.success) setCampaigns(json.data || [])
      else setCampaigns([])
    } catch {
      setCampaigns([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetch('/api/host/emails/audiences', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (j?.success) setAudiences(j.data) })
      .catch(() => {})
  }, [])

  // HOST-EMAILS.2 — the reminder report page navigates here after creating
  // a non-openers draft.
  useEffect(() => {
    if (searchParams?.get('notice') === 'reminder') setNotice('Reminder draft created. Edit it, test it, then send or schedule.')
  }, [searchParams])

  // Load the Unlayer embed script once; fall back to plain text if it never
  // arrives (blocked network, script error) so the host can always write.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.unlayer) { setUnlayerReady(true); return }
    const existing = document.querySelector(`script[src="${UNLAYER_SRC}"]`)
    const script = existing || document.createElement('script')
    let loaded = false
    let timer
    const onLoad = () => { loaded = true; clearTimeout(timer); setUnlayerReady(true) }
    const onError = () => { clearTimeout(timer); setDesignerNotice('failed'); if (!pendingDesignRef.current) setMode('text') }
    script.addEventListener('load', onLoad)
    script.addEventListener('error', onError)
    if (!existing) {
      script.src = UNLAYER_SRC
      script.async = true
      document.body.appendChild(script)
    }
    // A tag that is ALREADY in the DOM has usually already fired its `load`
    // event, and it will not fire again for this listener — so the designer
    // would sit on "Loading the designer..." forever. Same shape if the
    // network stalls the request. Give it a bounded wait, then say so.
    timer = setTimeout(() => {
      if (!loaded && !window.unlayer) setDesignerNotice('failed')
    }, UNLAYER_LOAD_TIMEOUT_MS)
    return () => {
      clearTimeout(timer)
      script.removeEventListener('load', onLoad)
      script.removeEventListener('error', onError)
    }
  }, [])

  // Init the designer when the script is up and design mode is showing.
  useEffect(() => {
    if (!unlayerReady || mode !== 'design') return
    if (editorInited.current) return
    const el = document.getElementById(EDITOR_DIV_ID)
    if (!el || !window.unlayer) return
    window.unlayer.init({
      id: EDITOR_DIV_ID,
      displayMode: 'email',
      appearance: { theme: 'dark' },
      // HOST-EMAIL.6 — the variables guide: Unlayer's built-in merge-tags
      // picker, limited to the tags the host send path substitutes.
      mergeTags: [
        { name: 'First name', value: '{{first_name}}' },
        { name: 'Last name', value: '{{last_name}}' },
        { name: 'Full name', value: '{{name}}' },
        { name: 'Email', value: '{{email}}' },
      ],
    })
    editorInited.current = true
    if (pendingDesignRef.current) {
      try { window.unlayer.loadDesign(pendingDesignRef.current) } catch { /* stale design doc */ }
      pendingDesignRef.current = null
      setDesignerNotice('')
    }
  }, [unlayerReady, mode])

  // The editor may already be initialised (from an earlier draft) by the
  // time a new draft with a pending design is opened — load it then too.
  useEffect(() => {
    if (!unlayerReady || !editorInited.current || !window.unlayer || !pendingDesignRef.current) return
    try { window.unlayer.loadDesign(pendingDesignRef.current) } catch { /* stale design doc */ }
    pendingDesignRef.current = null
    setDesignerNotice('')
  }, [unlayerReady, mode])

  function exportDesign() {
    return new Promise((resolve, reject) => {
      if (!window.unlayer) return reject(new Error('Designer not loaded'))
      try {
        window.unlayer.exportHtml((data) => resolve(data || {}))
      } catch (e) {
        reject(e)
      }
    })
  }

  // Wipe the designer canvas. Whenever the composer stops showing a design
  // (new email, or a draft that has no design_json) the editor must be
  // blanked, or the PREVIOUS draft's design stays on screen and a save
  // exports it onto the draft now being edited.
  function blankEditor() {
    if (!editorInited.current || typeof window === 'undefined' || !window.unlayer) return
    try {
      if (typeof window.unlayer.loadBlankTemplate === 'function') window.unlayer.loadBlankTemplate()
      else window.unlayer.loadDesign({ body: { rows: [] } })
    } catch { /* leave whatever design is showing */ }
  }

  function resetComposer() {
    setSubject('')
    setTextBody('')
    setAudienceEventId('')
    setEmailType('marketing')
    setEditingId(null)
    pendingDesignRef.current = null
    setDesignerNotice('')
    setDesignDropped(false)
    setHasDesign(false)
    setAudienceCampaignId(null)
    blankEditor()
  }

  // HOST-EMAILS.2 — deliberately drop a loaded/pending design and switch to
  // plain text. "Edit as text instead" is the only way in: a designed draft
  // always opens in design mode (Step 3f below).
  function dropDesign() {
    if (!window.confirm('This drops the saved design and keeps only the HTML.')) return
    pendingDesignRef.current = null
    setDesignerNotice('')
    setDesignDropped(true)
    setHasDesign(false)
    setMode('text')
  }

  async function editDraft(id) {
    setError('')
    setNotice('')
    setLoadingDraftId(id)
    try {
      const res = await fetch(`/api/host/emails/${id}`, { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not open the draft.')
        return
      }
      const c = json.data
      setEditingId(c.id)
      setSubject(c.subject || '')
      setAudienceEventId(c.audience_kind === 'mailing_list' ? '__mailing_list__' : (c.audience_event_id || ''))
      setEmailType(c.email_type === 'utility' ? 'utility' : 'marketing')
      setAudienceCampaignId(c.audience_kind === 'non_openers' ? c.audience_campaign_id || null : null)
      setDesignDropped(false)
      setTextBody(c.body_html || '')
      // HOST-EMAILS.2 — one decision, in designStateForDraft (tested there).
      // A designed draft ALWAYS opens in design mode: if the designer is not
      // up yet the design waits in pendingDesignRef and loads the moment the
      // editor initialises; text mode is only ever reached through "Edit as
      // text instead", or by opening a draft that has no design at all.
      const next = designStateForDraft(c, {
        editorInited: editorInited.current,
        unlayerReady: typeof window !== 'undefined' && Boolean(window.unlayer),
        previousNotice: designerNotice,
      })
      setMode(next.mode)
      setHasDesign(next.hasDesign)
      if (next.loadNow) {
        try { window.unlayer.loadDesign(c.design_json) } catch { /* stale design doc */ }
      } else if (!next.hasDesign) {
        // No design on THIS draft: drop any design still parked for another
        // one and clear the canvas, so nothing of the previous draft can be
        // loaded in later or exported over this draft on save.
        blankEditor()
      }
      pendingDesignRef.current = next.pendingDesign
      setDesignerNotice(next.notice)
      document.getElementById('host-email-subject')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } catch {
      setError('Could not open the draft.')
    } finally {
      setLoadingDraftId(null)
    }
  }

  async function saveDraft(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      let body = textBody
      let designJson = null
      if (mode === 'design') {
        const exported = await exportDesign()
        body = exported.html || ''
        designJson = exported.design || null
        if (!body.trim()) {
          setError('The design is empty — add some content first.')
          return
        }
      }
      const payload = {
        subject,
        body,
        design_json: designJson,
        audience_kind: audienceCampaignId ? 'non_openers' : (audienceEventId === '__mailing_list__' ? 'mailing_list' : (audienceEventId ? 'event' : 'all')),
        audience_event_id: audienceCampaignId ? null : (audienceEventId && audienceEventId !== '__mailing_list__' ? audienceEventId : null),
        audience_campaign_id: audienceCampaignId,
        email_type: emailType,
      }
      const res = await fetch(editingId ? `/api/host/emails/${editingId}` : '/api/host/emails', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not save the email.')
        return
      }
      resetComposer()
      setNotice('Draft saved — press Send when you’re ready.')
      await load()
    } catch {
      setError('Could not save the email.')
    } finally {
      setBusy(false)
    }
  }

  function audienceLabel(id) {
    if (!id) {
      return audiences.all_count == null
        ? 'all your emailable contacts'
        : `all ${audiences.all_count} contacts (where emailable)`
    }
    if (id === '__mailing_list__') {
      return audiences.mailing_list_count == null
        ? 'your mailing-list signups'
        : `your ${audiences.mailing_list_count} mailing-list signups (where emailable)`
    }
    const ev = audiences.events.find((x) => x.id === id)
    return ev ? `attendees of ${ev.name} (${ev.race_date})` : 'the selected event’s attendees'
  }

  // HOST-EMAIL.10 — a blank prompt must post {} and NOT { to: '' }: the route
  // reads a missing `to` as "the host's own email" but 400s an empty string,
  // so this is what makes "just send it to me" work. Exported for its test.
  async function sendTest(id) {
    const answer = window.prompt(
      'Send a test copy of this email to which address?\n\nLeave blank to send it to your own host email.',
      lastTestEmail,
    )
    if (answer === null) return // cancelled
    setError('')
    setNotice('')
    setTestingId(id)
    try {
      const res = await fetch(`/api/host/emails/${id}/send-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTestSendBody(answer)),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not send the test email.')
        return
      }
      const to = json.data?.to || ''
      setLastTestEmail(to)
      setNotice(`Test sent to ${to}. This draft is unchanged and nobody on your list was emailed.`)
    } catch {
      setError('Could not send the test email.')
    } finally {
      setTestingId(null)
    }
  }

  async function send(c) {
    const audienceLabelText = audienceLabel(c.audience_kind === 'mailing_list' ? '__mailing_list__' : (c.audience_event_id || ''))
    if (!window.confirm(sendConfirmCopy(c, audienceLabelText, campaignsById))) return
    setError('')
    setNotice('')
    setSendingId(c.id)
    try {
      const res = await fetch(`/api/host/emails/${c.id}/send`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        // The 409 messages ("Daily send limit reached.", "No emailable
        // contacts.", "Sending is not enabled — …") are user-facing.
        setError(json.error || 'Could not send the email.')
        return
      }
      const n = json.data?.recipient_count || 0
      setNotice(`Sending to ${n} contact${n === 1 ? '' : 's'} — this takes a few minutes.`)
      await load()
    } catch {
      setError('Could not send the email.')
    } finally {
      setSendingId(null)
    }
  }

  // HOST-EMAILS.2 — preview as sent: same HTML the recipient's inbox gets
  // (unsubscribe footer included), rendered in a sandboxed iframe so nothing
  // in the design can run script or navigate the host portal.
  async function previewAsSent() {
    setError('')
    setPreviewBusy(true)
    try {
      let body = textBody
      if (mode === 'design') {
        const exported = await exportDesign()
        body = exported.html || ''
      }
      if (!body.trim()) { setError('Add some content first.'); return }
      const res = await fetch('/api/host/emails/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body_html: body }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.error || 'Could not build the preview.'); return }
      setPreview({ html: json.data.html, width: 375 })
    } catch {
      setError('Could not build the preview.')
    } finally {
      setPreviewBusy(false)
    }
  }

  const closePreview = useCallback(() => setPreview(null), [])
  const setPreviewWidth = useCallback((width) => setPreview((p) => (p ? { ...p, width } : p)), [])

  async function deleteCampaign(c) {
    if (!window.confirm(`Delete "${c.subject}"? This cannot be undone.`)) return
    setError('')
    setNotice('')
    setRowBusyId(c.id)
    try {
      const res = await fetch(`/api/host/emails/${c.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.error || 'Could not delete the email.'); await load(); return }
      if (editingId === c.id) resetComposer()
      setNotice('Email deleted.')
      await load()
    } catch {
      // The request may have deleted the row before the network gave out, so
      // never leave a phantom row on screen: re-read the list either way.
      setError('Could not delete the email.')
      await load()
    } finally {
      setRowBusyId(null)
    }
  }

  async function duplicateCampaign(c) {
    setError('')
    setNotice('')
    setRowBusyId(c.id)
    try {
      const res = await fetch(`/api/host/emails/${c.id}/duplicate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.error || 'Could not duplicate the email.'); return }
      setNotice(`Draft created: ${json.data?.subject || 'Copy'}.`)
      await load()
    } catch {
      setError('Could not duplicate the email.')
    } finally {
      setRowBusyId(null)
    }
  }

  // HOST-SCHEDULE.1 — schedule panel + scheduled-row actions.
  function openSchedule(c) {
    setError('')
    setNotice('')
    const d = schedulePanelDefaults(c)
    setScheduleDate(d.date)
    setScheduleTime(d.time)
    setSchedulingId(c.id)
  }

  async function confirmSchedule(id) {
    setError('')
    setNotice('')
    const iso = dublinLocalToIso(scheduleDate, scheduleTime)
    if (!iso) { setError('Pick a valid date and time.'); return }
    setScheduleBusy(true)
    try {
      const res = await fetch(`/api/host/emails/${id}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_for: iso }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not schedule the email.')
        return
      }
      setSchedulingId(null)
      setNotice(`Scheduled for ${dublinScheduleLabel(json.data?.scheduled_for || iso)}.`)
      await load()
    } catch {
      setError('Could not schedule the email.')
    } finally {
      setScheduleBusy(false)
    }
  }

  // Returns true when the row is a draft again (so callers can chain).
  async function unschedule(id) {
    setError('')
    setNotice('')
    try {
      const res = await fetch(`/api/host/emails/${id}/unschedule`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not cancel the schedule.')
        await load() // a 409 means it already fired: show the real state
        return false
      }
      await load()
      return true
    } catch {
      setError('Could not cancel the schedule.')
      return false
    }
  }

  async function cancelSchedule(id) {
    if (!window.confirm('Cancel this scheduled send? The email goes back to your drafts.')) return
    setSchedulingId(null)
    setSchedulingBusyId(id)
    try {
      if (await unschedule(id)) setNotice('Schedule cancelled.')
    } finally {
      setSchedulingBusyId(null)
    }
  }

  async function editScheduled(id) {
    if (!window.confirm('Editing cancels the scheduled send. You can schedule it again after saving.')) return
    setSchedulingId(null)
    setSchedulingBusyId(id)
    try {
      if (await unschedule(id)) await editDraft(id)
    } finally {
      setSchedulingBusyId(null)
    }
  }

  const inputBase =
    'rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-white ' +
    'placeholder:text-white/30 focus:outline-none focus:border-white/40'
  const input = `w-full ${inputBase}`
  const btnSecondary =
    'rounded-lg border border-white/20 text-white/80 text-xs font-semibold px-3 py-1.5 ' +
    'hover:text-white hover:border-white/40 disabled:opacity-50'
  const btnPrimary =
    'rounded-lg bg-white text-black text-xs font-semibold px-3 py-1.5 hover:bg-white/90 disabled:opacity-50'

  return (
    <div>
      {(error || notice) && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
            error
              ? 'border-red-500/25 bg-red-500/10 text-red-300'
              : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {error || notice}
        </div>
      )}

      <section className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs uppercase tracking-[0.15em] text-white/45">
            {editingId ? 'Edit draft' : 'New email'}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={resetComposer}
              className="text-xs text-white/45 hover:text-white"
            >
              Discard changes · start a new email
            </button>
          )}
        </div>
        <form onSubmit={saveDraft} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="host-email-subject" className="block text-xs text-white/50 mb-1">Subject</label>
              <input
                id="host-email-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                required
                placeholder="e.g. Early-bird tickets are live"
                className={input}
              />
            </div>
            <div>
              <label htmlFor="host-email-audience" className="block text-xs text-white/50 mb-1">Send to</label>
              {audienceCampaignId ? (
                <>
                  <input
                    type="text"
                    id="host-email-audience"
                    readOnly
                    value={audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: audienceCampaignId }, campaignsById)}
                    aria-describedby="host-email-audience-note"
                    className={input}
                  />
                  <p id="host-email-audience-note" className="text-[11px] text-white/40 mt-0.5">Resolved when you send: anyone who has opened since then is left out. Duplicate this email to pick a different audience.</p>
                </>
              ) : (
                <select
                  id="host-email-audience"
                  value={audienceEventId}
                  onChange={(e) => setAudienceEventId(e.target.value)}
                  className={input}
                >
                  <option value="">
                    Everyone{audiences.all_count != null ? ` (${audiences.all_count})` : ''}
                  </option>
                  <option value="__mailing_list__">
                    Mailing list signups{audiences.mailing_list_count != null ? ` (${audiences.mailing_list_count})` : ''}
                  </option>
                  {audiences.events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      Attended · {ev.name} — {ev.race_date} ({ev.count})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div>
            <span className="block text-xs text-white/50 mb-1">Email type</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEmailType('marketing')}
                className={`flex-1 rounded-lg border px-3 py-2 text-left ${emailType === 'marketing' ? 'border-white/50 bg-white/[0.06]' : 'border-white/15 hover:border-white/30'}`}
              >
                <span className="block text-sm font-semibold">Marketing</span>
                <span className="block text-[11px] text-white/45 mt-0.5">Promotions and news. Only goes to contacts opted in to marketing.</span>
              </button>
              <button
                type="button"
                onClick={() => setEmailType('utility')}
                className={`flex-1 rounded-lg border px-3 py-2 text-left ${emailType === 'utility' ? 'border-white/50 bg-white/[0.06]' : 'border-white/15 hover:border-white/30'}`}
              >
                <span className="block text-sm font-semibold">Utility</span>
                <span className="block text-[11px] text-white/45 mt-0.5">Operational info for attendees — time changes, instructions. Reaches people regardless of marketing opt-in, so only use it for messages about their booking.</span>
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="block text-xs text-white/50">Message</span>
              <div className="flex gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => setMode('design')}
                  disabled={!unlayerReady}
                  className={`rounded px-2 py-0.5 ${mode === 'design' ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white'} disabled:opacity-40`}
                >
                  Design
                </button>
                <button
                  type="button"
                  onClick={() => ((pendingDesignRef.current || (hasDesign && mode === 'design' && !designDropped)) ? dropDesign() : setMode('text'))}
                  className={`rounded px-2 py-0.5 ${mode === 'text' ? 'bg-white/15 text-white' : 'text-white/45 hover:text-white'}`}
                >
                  Plain text
                </button>
              </div>
            </div>

            {mode === 'design' ? (
              <div className="rounded-lg overflow-hidden border border-white/15 bg-white/[0.02]">
                {/* Unlayer's iframe sizes to 100% of its container, so the
                    container needs a DEFINITE height — min-height alone lets
                    the iframe collapse (squashed toolbar + dead space). */}
                <div id={EDITOR_DIV_ID} style={{ height: 620 }}>
                  {(!unlayerReady || designerNotice) && (
                    <div className="p-4 text-sm text-white/60">
                      <p>{designerNotice === 'failed' ? 'The designer could not load. Reload the page, or edit as text (this drops the design).' : 'Loading the designer…'}</p>
                      {designerNotice !== '' && (
                        <button type="button" onClick={dropDesign} className="mt-2 text-xs underline text-white/70 hover:text-white">Edit as text instead</button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <textarea
                id="host-email-body"
                value={textBody}
                onChange={(e) => setTextBody(e.target.value)}
                maxLength={20000}
                required
                rows={8}
                placeholder="Write your email…"
                className={input}
              />
            )}
            <p className="text-[11px] text-white/35 mt-1">
              Sent with your sender name and an unsubscribe link added automatically.
              {' '}Personalise with variables: {'{{first_name}}'}, {'{{last_name}}'}, {'{{name}}'}, {'{{email}}'} — in the designer they&apos;re under the text toolbar&apos;s merge-tags menu.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Save draft'}
            </button>
            <button type="button" onClick={previewAsSent} disabled={previewBusy} className={btnSecondary}>
              {previewBusy ? 'Building…' : 'Preview as sent'}
            </button>
          </div>
        </form>
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Your emails</h2>
        {campaigns === null ? (
          <p className="text-white/40 text-sm">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="text-white/50 text-sm">No emails yet — write your first one above.</p>
        ) : (
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
            {campaigns.map((c) => {
              const chip = STATUS_CHIP[c.status] || 'bg-white/10 text-white/70'
              const actions = rowActions(c.status)
              return (
                <li key={c.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        {c.status === 'draft' || c.status === 'scheduled' ? (
                          <span className="truncate">{c.subject}</span>
                        ) : (
                          <Link href={`/host/emails/${c.id}`} className="truncate hover:underline">{c.subject}</Link>
                        )}
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip}`}>
                          {STATUS_LABEL[c.status] || c.status}
                        </span>
                        {c.status === 'draft' && c.schedule_error && (
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-300">
                            Not sent
                          </span>
                        )}
                        {c.email_type === 'utility' && (
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-sky-500/15 text-sky-300">
                            Utility
                          </span>
                        )}
                        {c.stats?.failed > 0 && (
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-300">
                            {c.stats.failed} failed
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-white/45 mt-0.5">
                        {rowSubline(c)}
                        {c.audience_kind === 'non_openers' && (
                          <span className="text-white/35"> · {audienceSummary(c, campaignsById)}</span>
                        )}
                        {c.status !== 'scheduled' && (
                          <>
                            {' · '}
                            {(c.sent_at || c.created_at || '').slice(0, 10) || '—'}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-3">
                      {c.status === 'draft' && (
                        <div className="shrink-0 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => editDraft(c.id)}
                            disabled={loadingDraftId === c.id || rowBusyId === c.id}
                            className={btnSecondary}
                          >
                            {loadingDraftId === c.id ? 'Opening…' : 'Edit'}
                          </button>
                          <button
                            type="button"
                            onClick={() => sendTest(c.id)}
                            disabled={testingId === c.id || rowBusyId === c.id}
                            className={btnSecondary}
                          >
                            {testingId === c.id ? 'Sending…' : 'Test'}
                          </button>
                          <button
                            type="button"
                            onClick={() => (schedulingId === c.id ? setSchedulingId(null) : openSchedule(c))}
                            disabled={rowBusyId === c.id}
                            aria-expanded={schedulingId === c.id}
                            aria-controls={`schedule-panel-${c.id}`}
                            className={btnSecondary}
                          >
                            Schedule
                          </button>
                          <button
                            type="button"
                            onClick={() => send(c)}
                            disabled={sendingId === c.id || rowBusyId === c.id}
                            className={btnPrimary}
                          >
                            {sendingId === c.id ? 'Sending…' : 'Send'}
                          </button>
                        </div>
                      )}
                      {c.status === 'scheduled' && (
                        <div className="shrink-0 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => (schedulingId === c.id ? setSchedulingId(null) : openSchedule(c))}
                            disabled={schedulingBusyId === c.id || rowBusyId === c.id}
                            aria-expanded={schedulingId === c.id}
                            aria-controls={`schedule-panel-${c.id}`}
                            className={btnSecondary}
                          >
                            Change time
                          </button>
                          <button
                            type="button"
                            onClick={() => editScheduled(c.id)}
                            disabled={loadingDraftId === c.id || schedulingBusyId === c.id || rowBusyId === c.id}
                            className={btnSecondary}
                          >
                            {schedulingBusyId === c.id || loadingDraftId === c.id ? 'Opening…' : 'Edit'}
                          </button>
                          <button
                            type="button"
                            onClick={() => cancelSchedule(c.id)}
                            disabled={schedulingBusyId === c.id || rowBusyId === c.id}
                            className="rounded-lg border border-red-400/40 text-red-300 text-xs font-semibold px-3 py-1.5 hover:border-red-300 disabled:opacity-50"
                          >
                            {schedulingBusyId === c.id ? 'Cancelling…' : 'Cancel'}
                          </button>
                        </div>
                      )}
                      {(actions.duplicate || actions.delete) && (
                        <div className="shrink-0 flex items-center gap-2">
                          {actions.duplicate && (
                            <button
                              type="button"
                              onClick={() => duplicateCampaign(c)}
                              disabled={rowBusyId === c.id}
                              className="text-xs text-white/50 hover:text-white disabled:opacity-50"
                            >
                              {rowBusyId === c.id ? 'Duplicating…' : 'Duplicate'}
                            </button>
                          )}
                          {actions.delete && (
                            <button
                              type="button"
                              onClick={() => deleteCampaign(c)}
                              disabled={rowBusyId === c.id}
                              className="text-xs text-red-300/80 hover:text-red-300 disabled:opacity-50"
                            >
                              {rowBusyId === c.id ? 'Working…' : 'Delete'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {schedulingId === c.id && (c.status === 'draft' || c.status === 'scheduled') && (
                    <div
                      id={`schedule-panel-${c.id}`}
                      className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 flex flex-wrap items-end gap-3"
                    >
                      <label className="block text-xs text-white/60">
                        Date
                        <input
                          type="date"
                          value={scheduleDate}
                          min={isoToDublinInputs(Date.now()).date}
                          onChange={(e) => setScheduleDate(e.target.value)}
                          className={`${inputBase} mt-1`}
                        />
                      </label>
                      <label className="block text-xs text-white/60">
                        Time (Dublin)
                        <select
                          value={scheduleTime}
                          onChange={(e) => setScheduleTime(e.target.value)}
                          className={`${inputBase} mt-1`}
                        >
                          {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => confirmSchedule(c.id)}
                        disabled={scheduleBusy}
                        className={btnPrimary}
                      >
                        {scheduleBusy ? 'Saving…' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSchedulingId(null)}
                        className="text-xs text-white/60 hover:text-white px-2 py-2"
                      >
                        Close
                      </button>
                      <p className="basis-full text-[11px] text-white/40 mt-1">
                        Starts sending within a few minutes of this time. Every check (sender, list, daily limit) runs again then.
                      </p>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {preview && (
        <HostEmailPreviewModal
          html={preview.html}
          width={preview.width}
          onWidth={setPreviewWidth}
          onClose={closePreview}
        />
      )}
    </div>
  )
}
