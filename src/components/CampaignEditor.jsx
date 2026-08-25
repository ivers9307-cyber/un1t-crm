'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { isoToLocalDatetime, localDatetimeToIso } from '@/lib/datetime-local'
import { Save, Send, Users, Code, Paintbrush, Mail, Loader2, CheckCircle2, AlertCircle, Calendar, X, Trash2 } from 'lucide-react'
import SendDetailHeader from './communications/SendDetailHeader'
import AudienceBuilder from './AudienceBuilder'
import SendQuietHoursNotice from './communications/SendQuietHoursNotice'
import CopyAssist from './communications/CopyAssist'
import { stripUnsetFilterRows } from '@/lib/audience-filter'
import { isCampaignContentEditable, campaignLockedReason, campaignUndeletableReason } from '@/lib/campaign-editability'
import { UNLAYER_MERGE_TAGS, MERGE_TAG_REFERENCE } from '@/lib/merge-tags'

// FILTER-P1.6 — what the send path ACTUALLY gates on, per
// buildAudienceQueryAsync (src/lib/postmark.js): the campaign's location, the
// per-location consent flag for the stream, email_status not in
// (bounced, complained), and — marketing only — no inactivity suppression
// (email_suppressed_at, mig 395). The old banner claimed a ClassPass
// exclusion that exists NOWHERE in the send path, and a "valid email" check
// that is vacuous because contacts.email is NOT NULL.
const AUDIENCE_GATES = {
  marketing: "this location's marketing opt-in, no hard bounce or spam complaint, and no inactivity suppression.",
  utility: "this location's transactional opt-in, and no hard bounce or spam complaint.",
}

// One POST per pause, not one per keystroke.
const COUNT_DEBOUNCE_MS = 400

export default function CampaignEditor({ campaign, locationId, userId, initialAudienceFilter = null }) {
  const router = useRouter()
  const db = createBrowserClient()
  const editorRef = useRef(null)

  const [tab, setTab] = useState('design')  // design, code, audience, settings
  const [name, setName] = useState(campaign?.name || '')
  const [subject, setSubject] = useState(campaign?.subject || '')
  const [previewText, setPreviewText] = useState(campaign?.preview_text || '')
  const [fromName, setFromName] = useState(campaign?.from_name || 'UN1T')
  const [fromEmail, setFromEmail] = useState(campaign?.from_email || '')
  const [emailType, setEmailType] = useState(campaign?.postmark_stream === 'outbound' ? 'utility' : 'marketing')
  const [replyTo, setReplyTo] = useState(campaign?.reply_to || '')
  // CAMPAIGN-AB — optional subject-line A/B test (mig 398). Enabled ⇔
  // ab_subject_b is saved non-null; pct/wait are clamped client-side
  // and CHECK-bounded in the DB (this editor writes columns directly).
  const [abEnabled, setAbEnabled] = useState(!!campaign?.ab_subject_b)
  const [abSubjectB, setAbSubjectB] = useState(campaign?.ab_subject_b || '')
  const [abTestPct, setAbTestPct] = useState(campaign?.ab_test_pct ?? 10)
  const [abWaitHours, setAbWaitHours] = useState(campaign?.ab_wait_hours ?? 4)
  const [audienceFilter, setAudienceFilter] = useState(
    // Precedence: existing draft > deep-link preset (e.g. ?segment=race_completed
    // from /communications/segments) > empty.
    campaign?.audience_filter || initialAudienceFilter || { filters: [], logic: 'and' }
  )
  const [htmlContent, setHtmlContent] = useState(campaign?.html_content || '')
  const [designJson, setDesignJson] = useState(campaign?.design_json || null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)

  // CAMPAIGN.13 — campaign-level status + live progress. The
  // status here reflects either the row we loaded in (initial)
  // OR a value the polling effect refreshed from the DB while
  // a send is in flight. Progress counts come from the same poll.
  const [campaignStatus, setCampaignStatus] = useState(campaign?.status || 'draft')

  // CAMPHIST.1 — may this campaign's content still change?
  //
  // This editor persists by writing the `campaigns` row DIRECTLY from the
  // browser Supabase client (see handleSave), so neither the 409 guard on
  // PUT /api/campaigns/[id] nor the mig 014 RLS policy (FOR ALL, no status
  // predicate) constrains it. That is how `?edit=1` on a sent campaign came to
  // silently overwrite the record its recipients, opens and clicks describe.
  // The detail page no longer routes a locked campaign here at all; this is
  // the second lock, for the two other entry points (UnifiedSendComposer's
  // "open full editor" and CampaignDetail's draft redirect).
  const contentEditable = isCampaignContentEditable(campaignStatus)
  const lockedReason = campaignLockedReason(campaignStatus)
  const [progress, setProgress] = useState({
    total_sent: campaign?.total_sent || 0,
    total_recipients: campaign?.total_recipients || 0,
    cancel_requested_at: campaign?.cancel_requested_at || null,
  })

  // Schedule-send UI state.
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // COMMSFIX.D.3b — seed the datetime-local input in LOCAL time. It used to be
  // `new Date(scheduled_at).toISOString().slice(0, 16)` — a UTC wall clock in a
  // local-time field, the exact mixing CLAUDE.md bans. handleSchedule then
  // reinterprets the shown value as local, so a 10:00 Dublin send reopened as
  // 09:00 and re-confirming (even without touching the time) moved the send an
  // hour earlier — again on every subsequent edit.
  const [scheduleAt, setScheduleAt] = useState(isoToLocalDatetime(campaign?.scheduled_at))
  const [audienceCount, setAudienceCount] = useState(null)
  // CAMPAIGN.5 — distinguish "haven't fetched yet" from "fetched but
  // errored" from "in flight". Without this the banner showed the same
  // "Save the campaign to compute the recipient count" copy whether the
  // campaign was unsaved OR the API call had silently 400'd.
  const [audienceState, setAudienceState] = useState('idle')  // idle | loading | ready | error
  const [audienceError, setAudienceError] = useState(null)
  const [campaignId, setCampaignId] = useState(campaign?.id || null)
  const [error, setError] = useState(null)
  // COMMSFIX.D.3a — initialise the mode FROM THE CONTENT. The old ternary was
  // `designJson ? 'visual' : 'visual'` — vestigial, always visual — so a draft
  // authored in the Code tab (or created through the Bearer /api/campaigns
  // n8n path) opened into a blank Unlayer canvas, and Save exported that blank
  // scaffold over the stored html_content. The branded email was gone with no
  // warning. html_content without a design_json is by definition code-authored.
  const [editorMode, setEditorMode] = useState(
    campaign?.html_content && !campaign?.design_json ? 'code' : 'visual'
  )  // visual or code
  const [unlayerLoaded, setUnlayerLoaded] = useState(false)

  // CAMPAIGN.1 — send-test state. testEmail defaults to the
  // operator's address; testStatus is { kind: 'idle'|'sending'|'sent'|'error', msg? }.
  const [testOpen, setTestOpen] = useState(false)
  const [testEmail, setTestEmail] = useState('')
  const [testStatus, setTestStatus] = useState({ kind: 'idle' })

  // CAMPAIGN.2 — visible save confirmation. Without this the operator
  // hits Save and gets no signal whether anything happened. Cleared
  // automatically after 3s.
  const [savedAt, setSavedAt] = useState(null)

  // Load Unlayer script
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.unlayer) {
      const script = document.createElement('script')
      script.src = 'https://editor.unlayer.com/embed.js'
      script.async = true
      script.onload = () => setUnlayerLoaded(true)
      document.body.appendChild(script)
    } else if (window.unlayer) {
      setUnlayerLoaded(true)
    }
  }, [])

  // Initialize Unlayer editor
  useEffect(() => {
    if (unlayerLoaded && tab === 'design' && editorMode === 'visual' && editorRef.current) {
      // Clear previous instance
      editorRef.current.innerHTML = ''

      window.unlayer.init({
        id: 'unlayer-editor',
        projectId: undefined,  // No account needed for basic features
        displayMode: 'email',
        appearance: {
          theme: 'dark',
          panels: {
            tools: { dock: 'left' },
          },
        },
        tools: {
          image: { enabled: true },
          button: { enabled: true },
          divider: { enabled: true },
          heading: { enabled: true },
          html: { enabled: true },
          menu: { enabled: true },
          social: { enabled: true },
          text: { enabled: true },
          timer: { enabled: true },
          video: { enabled: true },
        },
        // K3 — from @/lib/merge-tags, which is checked against what
        // applyMergeTags() actually substitutes. Do not re-inline this list.
        mergeTags: [...UNLAYER_MERGE_TAGS],
        features: {
          textEditor: {
            spellChecker: true,
          },
        },
      })

      // Load existing design if editing
      if (designJson) {
        window.unlayer.loadDesign(designJson)
      }
    }
    // designJson is intentionally NOT a dep — re-loading it after the
    // user starts editing would clobber their in-progress changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlayerLoaded, tab, editorMode])

  // Get HTML and design JSON from Unlayer.
  // CAMPAIGN.3 — the exportHtml callback never fires when the Unlayer
  // iframe isn't mounted (e.g., operator clicked Save while on the
  // Audience tab). Without a timeout the promise hung forever, which
  // locked Save and Send-Test in a permanent spinner.
  const exportFromUnlayer = useCallback(() => {
    return new Promise((resolve) => {
      if (!window.unlayer || typeof window.unlayer.exportHtml !== 'function') {
        resolve({ html: htmlContent, design: designJson })
        return
      }
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve({ html: htmlContent, design: designJson })
      }, 2500)
      try {
        window.unlayer.exportHtml((data) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve({ html: data?.html ?? htmlContent, design: data?.design ?? designJson })
        })
      } catch {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ html: htmlContent, design: designJson })
      }
    })
  }, [htmlContent, designJson])

  // Save campaign
  // CAMPAIGN.2 — single source of truth for "get the latest content
  // out of Unlayer and into React state". Used by:
  //   - handleSave (so the persisted payload includes in-progress edits)
  //   - switchTab  (so a Design → Audience → Design round-trip doesn't
  //                  re-init Unlayer with a stale designJson and wipe
  //                  the operator's work)
  // Returns { html, design } so handleSave can use the values
  // directly without waiting for setState to flush.
  const stashUnlayerToState = useCallback(async () => {
    // CAMPAIGN.3 — only attempt to export from Unlayer when the Design
    // tab is actually mounted. The Design tab is conditionally rendered
    // ({tab === 'design' && ...}), so on the Audience/Settings tabs the
    // Unlayer iframe is gone and exportHtml's callback never fires —
    // hanging Save and Send-Test forever. When we're not on the Design
    // tab the React state (htmlContent/designJson) already holds the
    // latest stashed content from when the operator last left the tab.
    if (tab !== 'design' || editorMode !== 'visual' || !window.unlayer) {
      return { html: htmlContent, design: designJson }
    }
    try {
      const exported = await exportFromUnlayer()
      // Update React state so the next Design-tab mount has the
      // latest design to load from.
      setHtmlContent(exported.html)
      setDesignJson(exported.design)
      return exported
    } catch {
      return { html: htmlContent, design: designJson }
    }
  }, [tab, editorMode, exportFromUnlayer, htmlContent, designJson])

  async function handleSave() {
    // CAMPHIST.1 — last line of defence before the direct browser write. The
    // Save button is not rendered when the content is locked, but this runs
    // whatever called it, and the cost of being wrong here is an unrecoverable
    // rewrite of what was actually sent.
    if (!contentEditable) {
      setError(lockedReason)
      return
    }
    setSaving(true)
    setError(null)

    try {
      const { html, design } = await stashUnlayerToState()

      const payload = {
        name: name || 'Untitled Campaign',
        subject,
        preview_text: previewText || null,
        from_name: fromName || null,
        from_email: fromEmail || null,
        reply_to: replyTo || null,
        design_json: design,
        html_content: html,
        audience_filter: stripUnsetFilterRows(audienceFilter),
        location_id: locationId,
        created_by: userId,
        // Marketing → broadcast stream; Utility → outbound (transactional)
        // stream + email_administrative gate. Direct column write (this
        // editor persists via the browser Supabase client, not the API).
        postmark_stream: emailType === 'utility' ? 'outbound' : 'broadcast',
        // CAMPAIGN-AB — a blank/disabled variant B saves NULL (test off).
        // Bounds mirror the DB CHECKs (pct 5-50, wait 1-24h).
        ab_subject_b: abEnabled && abSubjectB.trim() ? abSubjectB.trim() : null,
        ab_test_pct: Math.min(50, Math.max(5, Math.round(Number(abTestPct) || 10))),
        ab_wait_hours: Math.min(24, Math.max(1, Math.round(Number(abWaitHours) || 4))),
      }

      let result
      if (campaignId) {
        result = await db.from('campaigns').update(payload).eq('id', campaignId).select().single()
      } else {
        result = await db.from('campaigns').insert({ ...payload, status: 'draft' }).select().single()
      }

      if (result.error) throw new Error(result.error.message)

      if (!campaignId) {
        setCampaignId(result.data.id)
        // Update URL without navigation
        window.history.replaceState(null, '', `/communications/sent/email/${result.data.id}`)
      }

      // CAMPAIGN.2 — visible save confirmation. Cleared after 3s.
      setSavedAt(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // CAMPAIGN.2 — wrap setTab so leaving the Design tab stashes the
  // current Unlayer content into React state. Without this, switching
  // to another tab and back re-initialises Unlayer with the stale
  // designJson and wipes in-progress edits.
  async function switchTab(nextTab) {
    if (nextTab === tab) return
    if (tab === 'design') {
      await stashUnlayerToState()
    }
    setTab(nextTab)
  }

  // Auto-clear the "Saved" indicator after 3s.
  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(null), 3000)
    return () => clearTimeout(t)
  }, [savedAt])

  // Send campaign
  async function handleSend() {
    if (!campaignId) {
      await handleSave()
    }

    if (!confirm(`Send this campaign to ${audienceCount || 'all matching'} contacts? This cannot be undone.`)) return

    setSending(true)
    setError(null)

    try {
      // Save latest content first
      await handleSave()

      const response = await fetch(`/api/campaigns/${campaignId}/send`, {
        method: 'POST',
      })

      const result = await response.json()

      if (!result.success) throw new Error(result.error)

      // Optimistic state — the cron will pick this up within 60s.
      setCampaignStatus('queued')
      router.refresh()
    } catch (err) {
      setError(err.message)
      setSending(false)
    }
  }

  // CAMPAIGN.13 — schedule the campaign to send at a future time.
  // Same write the run-campaigns cron's promote-step picks up
  // (status='scheduled' AND scheduled_at <= now()). No call to the
  // send endpoint — the cron will promote and dispatch.
  async function handleSchedule() {
    if (!scheduleAt) {
      setError('Pick a date and time first.')
      return
    }
    // The picker's value is a local wall clock; localDatetimeToIso reads it in
    // the operator's zone (the exact inverse of the seeding above).
    const iso = localDatetimeToIso(scheduleAt)
    if (!iso) {
      setError('That date and time could not be read. Pick it again.')
      return
    }
    if (new Date(iso) <= new Date()) {
      setError('Scheduled time must be in the future.')
      return
    }
    if (!confirm(`Schedule "${name}" to send at ${new Date(iso).toLocaleString('en-IE')}?`)) return

    setSending(true)
    setError(null)
    try {
      await handleSave()
      const { error: upErr } = await db.from('campaigns')
        .update({ status: 'scheduled', scheduled_at: iso, cancel_requested_at: null })
        .eq('id', campaignId)
      if (upErr) throw new Error(upErr.message)
      setCampaignStatus('scheduled')
      setScheduleOpen(false)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  // CAMPAIGN.13 — cancel a queued/sending/scheduled campaign.
  // For 'scheduled' we flip back to 'draft' so it stops being a
  // promotion candidate. For 'queued' / 'sending' we set
  // cancel_requested_at; the run-campaigns cron sees the flag
  // between chunks and transitions status='cancelled' + flips
  // remaining queued recipients to 'cancelled'.
  async function handleCancel() {
    if (!confirm('Stop this campaign? Already-sent emails cannot be unsent.')) return
    setError(null)
    try {
      if (campaignStatus === 'scheduled') {
        const { error: e } = await db.from('campaigns')
          .update({ status: 'draft', scheduled_at: null })
          .eq('id', campaignId)
        if (e) throw new Error(e.message)
        setCampaignStatus('draft')
      } else {
        const { error: e } = await db.from('campaigns')
          .update({ cancel_requested_at: new Date().toISOString() })
          .eq('id', campaignId)
        if (e) throw new Error(e.message)
        setProgress((p) => ({ ...p, cancel_requested_at: new Date().toISOString() }))
      }
      router.refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  // CAMPAIGN.13 — delete the campaign.
  //
  // CAMPDEL.1 — this used to refuse only ['queued','sending'] and then delete
  // straight from the browser Supabase client. Two problems, the same pair
  // CAMPHIST.1 found on save:
  //
  //   • The 409 on DELETE /api/campaigns/[id] never runs, because this does not
  //     call that route. It cannot: `authenticateApiKey` is Bearer-only, so an
  //     operator's session cookie gets a 401 there. And campaigns_location_scoped
  //     (mig 014) is `FOR ALL ... USING auth_is_in_location(location_id)` with no
  //     status predicate, so the database allows the delete too.
  //   • `campaignStatus` is React state read at load. An operator sitting on a
  //     'scheduled' campaign while the run-campaigns cron sends it still holds
  //     'scheduled' here, so the old check would have happily deleted a campaign
  //     that had just gone out, cascading away every campaign_recipients and
  //     campaign_link_clicks row with it.
  //
  // So re-read the status from the database immediately before deleting and
  // apply the same predicate the route does. If the re-read yields nothing
  // (row gone, transient error) fall back to the loaded status: that is the
  // freshest thing we have, and failing closed on a blip would block a
  // legitimate draft delete for no safety gain.
  async function handleDelete() {
    setError(null)
    const { data: fresh } = await db.from('campaigns').select('status').eq('id', campaignId).single()
    const status = fresh?.status ?? campaignStatus
    if (!isCampaignContentEditable(status)) {
      if (['queued', 'sending'].includes(status)) {
        setError('This campaign is sending. Cancel the send first, then delete.')
      } else {
        setError(campaignUndeletableReason(status))
      }
      setCampaignStatus(status)
      return
    }
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return
    try {
      const { error: e } = await db.from('campaigns').delete().eq('id', campaignId)
      if (e) throw new Error(e.message)
      // COMMSFIX.D.3c — deleting a draft used to land the operator on
      // /email/campaigns, which has no page.js (the list was retired), so they
      // got the Next.js 404 and read it as "did the delete break something?".
      // The Sent list is where the draft was opened from; go straight there.
      router.push('/communications/sent')
    } catch (err) {
      setError(err.message)
    }
  }

  // CAMPAIGN.13 — poll for live progress while a send is in flight.
  // Poll every 3s; stop when status transitions out of queued/sending.
  // GET /api/campaigns/[id] returns the latest row (status + the
  // total_* counters that CAMPAIGN.12's recalculate_campaign_stats
  // keeps in sync mid-send).
  useEffect(() => {
    if (!campaignId) return
    if (!['queued', 'sending'].includes(campaignStatus)) return
    let cancelled = false
    const tick = async () => {
      const { data, error } = await db.from('campaigns')
        .select('status, total_sent, total_recipients, cancel_requested_at')
        .eq('id', campaignId)
        .single()
      if (cancelled || error || !data) return
      setCampaignStatus(data.status)
      setProgress({
        total_sent: data.total_sent || 0,
        total_recipients: data.total_recipients || 0,
        cancel_requested_at: data.cancel_requested_at,
      })
    }
    const handle = setInterval(tick, 3000)
    tick() // immediate first hit
    return () => { cancelled = true; clearInterval(handle) }
    // `db` is captured from the closure and is stable for the
    // component's lifetime. We only want the polling loop to reset
    // when campaignId / status change — not on every render that
    // re-resolves the db client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, campaignStatus])

  // CAMPAIGN.1 — fire a test send to the operator's chosen address
  // (defaults to themselves). Auto-saves the draft first so the test
  // matches the latest edits.
  async function handleSendTest() {
    if (!subject || !htmlContent) {
      setTestStatus({ kind: 'error', msg: 'Add a subject and body before sending a test.' })
      return
    }
    setTestStatus({ kind: 'sending' })
    try {
      // Save first so the test renders the latest content.
      if (!campaignId) await handleSave()
      else await handleSave()
      const r = await fetch(`/api/campaigns/${campaignId}/send-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testEmail ? { to: testEmail } : {}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.success) {
        setTestStatus({ kind: 'error', msg: j.error || `HTTP ${r.status}` })
        return
      }
      setTestStatus({
        kind: 'sent',
        msg: j.message || `Sent to ${j.to}.`,
      })
      // Clear the success state after 4s so the operator can send again.
      setTimeout(() => setTestStatus((s) => (s.kind === 'sent' ? { kind: 'idle' } : s)), 4000)
    } catch (e) {
      setTestStatus({ kind: 'error', msg: e?.message || 'Network error' })
    }
  }

  // Fetch audience count
  // CAMPAIGN.5 — POSTs the in-flight filter so the count reflects what
  // the operator is currently editing (not just what's been saved).
  // Falls back to the saved filter server-side if body.filter is omitted.
  // Tracks loading + error state so the banner can show what's actually
  // happening rather than always saying "Save the campaign to compute".
  // FILTER-P1.6 — LAST REQUEST WINS. The count used to fire from the
  // builder's onChange AND from a useEffect on the same state — two POSTs per
  // keystroke, un-debounced, unabortable and unordered. A slow earlier
  // response overwrote a later one, leaving a stale number on screen that the
  // Send confirm dialog then quoted verbatim. Every request now carries a
  // sequence number; only the newest may write state, and the previous one is
  // aborted rather than left racing.
  const countSeqRef = useRef(0)
  const countAbortRef = useRef(null)
  const refreshAudienceCount = useCallback(async (filterOverride) => {
    if (!campaignId) {
      setAudienceState('idle')
      return
    }
    const seq = ++countSeqRef.current
    countAbortRef.current?.abort()
    const controller = new AbortController()
    countAbortRef.current = controller
    setAudienceState('loading')
    setAudienceError(null)
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // FILTER-P1.1 — a half-built row never reaches the count endpoint.
        body: JSON.stringify({ filter: stripUnsetFilterRows(filterOverride ?? audienceFilter), email_type: emailType }),
        signal: controller.signal,
      })
      const result = await response.json().catch(() => ({}))
      if (seq !== countSeqRef.current) return   // superseded — do not write state
      if (!response.ok || !result.success) {
        setAudienceState('error')
        setAudienceError(result?.error || `HTTP ${response.status}`)
        return
      }
      setAudienceCount(result.audience_count)
      setAudienceState('ready')
    } catch (err) {
      // An abort is this component superseding itself, not a failure to show.
      if (seq !== countSeqRef.current || err?.name === 'AbortError') return
      setAudienceState('error')
      setAudienceError(err?.message || 'Network error')
    }
  }, [campaignId, audienceFilter, emailType])

  useEffect(() => {
    if (!campaignId) return
    // Debounced: one POST per pause, not one per keystroke. This effect is now
    // the ONLY count trigger — the builder's onChange no longer calls it too.
    const t = setTimeout(() => { refreshAudienceCount() }, COUNT_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [campaignId, audienceFilter, refreshAudienceCount])

  const tabs = [
    { key: 'design', label: 'Design', icon: Paintbrush },
    { key: 'audience', label: 'Audience', icon: Users },
    { key: 'settings', label: 'Settings', icon: null },
  ]

  return (
    <div>
      {/* COMMS-IA.1 — the shared send-detail chrome. This editor used to take
          the full viewport with a top bar of its own; it now renders inside the
          Communications shell like its SMS and WhatsApp siblings. The name
          field and the whole action rail are body state, so they ride in as
          slots. Back-link target unchanged (COMMSLAYOUT.4). */}
      <SendDetailHeader
        channel="email"
        title={
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Campaign name..."
            className="bg-transparent text-lg font-semibold text-un1t-text placeholder:text-un1t-muted focus:outline-none w-64 max-w-full"
          />
        }
        /* CAMPHIST.1 — was hard-coded to "Draft". A sent campaign opened via
           ?edit=1 therefore LOOKED like a draft while being edited, which is
           what made the corruption invisible to the operator doing it. */
        status={(
          <span
            data-testid="campaign-status-pill"
            className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full capitalize"
          >
            {campaignStatus || 'draft'}
          </span>
        )}
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
          {audienceCount !== null && (
            <span className="text-xs text-un1t-subtle mr-2">
              <Users size={12} className="inline mr-1" />
              {audienceCount} recipients
            </span>
          )}
          {contentEditable && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          {/* CAMPAIGN.2 — visible save confirmation. Without this the
              operator hit Save and got no signal anything happened. */}
          {savedAt && !saving && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
              <CheckCircle2 size={12} />
              Saved {savedAt.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {/* CAMPAIGN.1 — send-test button. Click opens a small inline
              form pre-filled with the operator's address; submit
              actually sends. Toast-style status sits below the bar. */}
          <button
            type="button"
            onClick={() => setTestOpen((v) => !v)}
            className="flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors"
            title="Send a test copy to your inbox before broadcasting"
          >
            <Mail size={14} />
            Send test
          </button>
          {/* CAMPAIGN.13 — status-aware action buttons. The exact set
              depends on where in the lifecycle the campaign is. */}
          {(['draft'].includes(campaignStatus)) && (
            <>
              <button
                type="button"
                onClick={() => setScheduleOpen((v) => !v)}
                disabled={sending || !subject}
                className="flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
                title="Send at a later date and time"
              >
                <Calendar size={14} />
                Schedule
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={sending || !subject}
                className="flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
              >
                <Send size={14} />
                {sending ? 'Queueing…' : 'Send Campaign'}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                data-testid="campaign-delete"
                className="flex items-center gap-1.5 text-sm text-red-700 hover:text-red-800 border border-un1t-border hover:border-red-700/40 px-3 py-1.5 rounded-md transition-colors"
                title="Delete this draft"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
          {campaignStatus === 'scheduled' && (
            <>
              <span className="text-xs text-emerald-700 flex items-center gap-1">
                <Calendar size={12} />
                Scheduled {campaign?.scheduled_at ? new Date(campaign.scheduled_at).toLocaleString('en-IE') : ''}
              </span>
              <button
                type="button"
                onClick={handleCancel}
                className="flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors"
              >
                <X size={14} />
                Unschedule
              </button>
              <button
                type="button"
                onClick={handleDelete}
                data-testid="campaign-delete"
                title="Delete this campaign"
                className="flex items-center gap-1.5 text-sm text-red-700 hover:text-red-800 border border-un1t-border hover:border-red-700/40 px-3 py-1.5 rounded-md transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
          {['queued', 'sending'].includes(campaignStatus) && (
            <>
              <span className="text-xs text-un1t-subtle flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {progress.cancel_requested_at
                  ? 'Cancelling…'
                  : (campaignStatus === 'queued'
                      ? 'Queued — sending will start within 60s'
                      : `Sending ${progress.total_sent.toLocaleString()} / ${progress.total_recipients.toLocaleString()}`)}
              </span>
              <button
                type="button"
                onClick={handleCancel}
                disabled={!!progress.cancel_requested_at}
                className="flex items-center gap-1.5 text-sm text-red-700 hover:text-red-800 border border-un1t-border hover:border-red-700/40 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
              >
                <X size={14} />
                Cancel
              </button>
            </>
          )}
          {['sent', 'cancelled'].includes(campaignStatus) && (
            <span className="text-xs text-un1t-subtle">
              {campaignStatus === 'sent'
                ? `Sent ${progress.total_sent.toLocaleString()} / ${progress.total_recipients.toLocaleString()}`
                : 'Cancelled'}
            </span>
          )}
          </div>
        }
      />

      {/* CAMPHIST.1 — say plainly why nothing can be saved, and where to go
          instead. Without this the editor just silently has no Save button,
          which reads as a bug rather than a rule. */}
      {lockedReason && (
        <div
          data-testid="campaign-locked-notice"
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-700"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{lockedReason}</span>
        </div>
      )}

      {/* GAPS-P4 — quiet-hours advisory, sitting under the action bar so it is
          in the same glance as "Send Campaign" and the schedule tray. Only on
          a draft: that is the only state either control can fire from. When
          the tray holds a valid future time we judge THAT instant; otherwise
          we judge now, which is what "Send Campaign" would do. It never
          disables the button. */}
      {campaignStatus === 'draft' && (
        <div className="mb-4">
          <SendQuietHoursNotice
            locationId={locationId}
            at={scheduleOpen && scheduleAt ? localDatetimeToIso(scheduleAt) : null}
            onSuggest={(iso) => {
              setScheduleOpen(true)
              setScheduleAt(isoToLocalDatetime(iso))
            }}
          />
        </div>
      )}

      {/* CAMPAIGN.13 — schedule tray (mirrors the test-send tray). */}
      {scheduleOpen && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg px-3 py-3 mb-4 flex items-center gap-3 flex-wrap">
          <Calendar size={14} className="text-un1t-subtle" />
          <span className="text-sm text-un1t-subtle">Send at:</span>
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
          />
          <button
            type="button"
            onClick={handleSchedule}
            disabled={sending || !scheduleAt}
            className="inline-flex items-center gap-1.5 text-sm bg-emerald-600 text-white font-medium px-4 py-1.5 rounded-md hover:bg-emerald-500 disabled:opacity-50"
          >
            {sending ? <><Loader2 size={14} className="animate-spin" /> Scheduling…</> : <><Calendar size={14} /> Schedule</>}
          </button>
          <button
            type="button"
            onClick={() => setScheduleOpen(false)}
            className="text-sm text-un1t-subtle hover:text-un1t-text"
          >
            Cancel
          </button>
        </div>
      )}

      {/* CAMPAIGN.1 — test-send tray. Sits below the top bar so the
          operator can pick a recipient (defaults to their own email
          if blank), fire it, and see the status without leaving the
          editor view. */}
      {testOpen && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg px-3 py-3 mb-4 flex items-center gap-3 flex-wrap">
          <Mail size={14} className="text-un1t-subtle" />
          <span className="text-sm text-un1t-subtle">Send a test copy to:</span>
          <input
            type="email"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            placeholder="your@email.com (defaults to your account email)"
            className="flex-1 max-w-md bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
          />
          <button
            type="button"
            onClick={handleSendTest}
            disabled={testStatus.kind === 'sending'}
            className="inline-flex items-center gap-1.5 text-sm bg-emerald-600 text-white font-medium px-4 py-1.5 rounded-md hover:bg-emerald-500 disabled:opacity-50"
          >
            {testStatus.kind === 'sending'
              ? <><Loader2 size={14} className="animate-spin" /> Sending…</>
              : <><Send size={14} /> Send</>}
          </button>
          {testStatus.kind === 'sent' && (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
              <CheckCircle2 size={12} /> {testStatus.msg}
            </span>
          )}
          {testStatus.kind === 'error' && (
            <span className="inline-flex items-center gap-1.5 text-xs text-rose-700">
              <AlertCircle size={12} /> {testStatus.msg}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg text-red-700 text-sm px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-un1t-border">
        {tabs.map(t => (
          <button
            type="button"
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'text-un1t-text border-un1t-text'
                : 'text-un1t-subtle border-transparent hover:text-un1t-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div>
        {tab === 'design' && (
          <div className="h-full flex flex-col">
            {/* Visual/Code toggle */}
            <div className="flex items-center gap-2 px-5 py-2 bg-un1t-surface border-b border-un1t-border">
              <button
                type="button"
                onClick={() => setEditorMode('visual')}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
                  editorMode === 'visual' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                <Paintbrush size={12} /> Visual Editor
              </button>
              <button
                type="button"
                onClick={async () => {
                  // Export from Unlayer before switching to code
                  if (editorMode === 'visual' && window.unlayer) {
                    const exported = await exportFromUnlayer()
                    setHtmlContent(exported.html)
                    setDesignJson(exported.design)
                  }
                  setEditorMode('code')
                }}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
                  editorMode === 'code' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                <Code size={12} /> HTML Code
              </button>
            </div>

            {editorMode === 'visual' ? (
              // UNLAYER-H.1 — the mount div MUST have a DEFINITE height (not
              // just min-height): Unlayer's embed sizes its iframe
              // `height: 100%`, and a percentage against a min-height-only
              // parent resolves to auto, collapsing the editor to the 150px
              // iframe default under a dead dark block. Upstream embed.js is
              // unversioned, so this arrived with no code change on our side.
              <div id="unlayer-editor" ref={editorRef} className="flex-1" style={{ height: '75vh', minHeight: '600px' }} />
            ) : (
              <textarea
                value={htmlContent}
                onChange={e => setHtmlContent(e.target.value)}
                placeholder="Paste or write your HTML email here..."
                className="flex-1 w-full bg-black text-green-400 font-mono text-sm p-5 resize-none focus:outline-none"
                style={{ minHeight: '600px' }}
              />
            )}
          </div>
        )}

        {tab === 'audience' && (
          <div className="p-6 max-w-3xl">
            <h3 className="text-lg font-semibold mb-1">Audience</h3>
            <p className="text-sm text-un1t-subtle mb-4">
              Define who receives this campaign.{' '}
              {emailType === 'utility'
                ? 'Utility (transactional) send — reaches contacts who have not opted out of transactional email; the marketing opt-out is ignored. Set the type in Settings.'
                : 'Only contacts who have opted in to email marketing will be included.'}
            </p>
            {/* CAMPAIGN.1 — prominent recipient-count banner. Updates
                whenever the audience filter changes. Excludes
                ClassPass contacts (CONSENT.2), unsubscribed contacts,
                and bounced/complained email statuses — same gates the
                actual send applies. */}
            {/* CAMPAIGN.5 — banner has four distinct states so the
                operator can see what's actually happening rather than a
                generic dash. */}
            {(() => {
              const isError = audienceState === 'error'
              const isLoading = audienceState === 'loading'
              const tone = isError
                ? 'bg-red-500/10 border-red-500/40'
                : 'bg-emerald-500/10 border-emerald-500/40'
              const iconColor = isError ? 'text-red-700' : 'text-emerald-700'
              const showCount = audienceState === 'ready' && audienceCount !== null
              return (
                <div className={`${tone} border rounded-lg p-4 mb-6 flex items-center gap-3`}>
                  <Users size={20} className={`${iconColor} shrink-0`} />
                  <div>
                    <div data-testid="audience-count" className="text-2xl font-semibold text-un1t-text tabular-nums">
                      {showCount
                        ? audienceCount.toLocaleString()
                        : isLoading ? 'Computing…' : '—'}
                    </div>
                    <div className="text-xs text-un1t-subtle">
                      {showCount
                        ? `contact${audienceCount === 1 ? '' : 's'} will receive this campaign — already filtered for ${AUDIENCE_GATES[emailType === 'utility' ? 'utility' : 'marketing']}`
                        : isError
                          ? `Couldn't compute recipient count: ${audienceError || 'unknown error'}`
                          : isLoading
                            ? 'Counting matching contacts…'
                            : 'Save the campaign to compute the recipient count.'}
                    </div>
                  </div>
                </div>
              )
            })()}
            <AudienceBuilder
              filter={audienceFilter}
              // FILTER-P1.6 — setState only. The debounced effect above owns
              // the count; calling it here too is what made it fire twice.
              onChange={setAudienceFilter}
              audienceCount={audienceCount}
              locationId={locationId}
              // FILTER-C.3 — no seeded starting row. `Stage = member` looked
              // like a filter the operator had chosen and silently kept every
              // lead out of the campaign; FILTER-B.3 removed it from the
              // WhatsApp/SMS editors on the same argument.
            />
          </div>
        )}

        {tab === 'settings' && (
          <div className="p-6 max-w-2xl space-y-6">
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Email Settings</h3>

              <div>
                <label className="block text-sm mb-1.5">Subject Line *</label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="Your subject line — use {{first_name}} for personalisation"
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                />
                {/* GAPS-P8 — suggestions only. Nothing is applied until the
                    operator clicks Use; body variants copy to the clipboard
                    rather than overwrite the Unlayer design. */}
                <CopyAssist
                  className="mt-2"
                  locationId={locationId}
                  subject={subject}
                  getBody={async () => (await stashUnlayerToState()).html || ''}
                  onUseSubject={setSubject}
                />
              </div>

              {/* CAMPAIGN-AB — optional subject-line A/B test. The send
                  cron mails variant A/B to a small slice, waits, then
                  sends everyone else the better-opening subject. */}
              <div className="border border-un1t-border rounded-md p-4 space-y-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={abEnabled}
                    onChange={e => setAbEnabled(e.target.checked)}
                    className="accent-emerald-600"
                  />
                  <span className="font-medium">A/B test the subject line</span>
                </label>
                {abEnabled ? (
                  <>
                    <p className="text-xs text-un1t-muted">
                      A test slice gets subject A (above) or subject B; after the wait,
                      the rest of the audience automatically gets whichever subject was
                      opened more. Ties go to subject A.
                    </p>
                    <div>
                      <label className="block text-sm mb-1.5">Subject B *</label>
                      <input
                        type="text"
                        value={abSubjectB}
                        onChange={e => setAbSubjectB(e.target.value)}
                        placeholder="The alternative subject line to test"
                        className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                      />
                      {!abSubjectB.trim() && (
                        <p className="mt-1 text-xs text-amber-700">
                          Leave this empty and the campaign sends without a test.
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm mb-1.5">Test slice (% of audience)</label>
                        <input
                          type="number"
                          min={5}
                          max={50}
                          value={abTestPct}
                          onChange={e => setAbTestPct(e.target.value)}
                          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                        />
                        <p className="mt-1 text-xs text-un1t-muted">5–50%, split half A / half B</p>
                      </div>
                      <div>
                        <label className="block text-sm mb-1.5">Wait before deciding (hours)</label>
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={abWaitHours}
                          onChange={e => setAbWaitHours(e.target.value)}
                          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                        />
                        <p className="mt-1 text-xs text-un1t-muted">1–24h after the slice finishes</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-un1t-muted">
                    Send two subject lines to a small test slice and let the rest of the
                    audience get the one that performs better.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm mb-1.5">Email type</label>
                <div className="inline-flex rounded-md border border-un1t-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setEmailType('marketing')}
                    className={`px-3 py-1.5 text-sm ${emailType === 'marketing' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
                  >Marketing</button>
                  <button
                    type="button"
                    onClick={() => setEmailType('utility')}
                    className={`px-3 py-1.5 text-sm border-l border-un1t-border ${emailType === 'utility' ? 'bg-un1t-text text-un1t-bg' : 'text-un1t-subtle hover:text-un1t-text'}`}
                  >Utility</button>
                </div>
                {emailType === 'utility' && (
                  <p className="mt-1 text-xs text-amber-700">
                    Booking/transactional only — ignores marketing opt-out. Using this for marketing breaches consent.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm mb-1.5">Preview Text</label>
                <input
                  type="text"
                  value={previewText}
                  onChange={e => setPreviewText(e.target.value)}
                  placeholder="Short text shown in inbox preview (optional)"
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1.5">From Name</label>
                  <input
                    type="text"
                    value={fromName}
                    onChange={e => setFromName(e.target.value)}
                    placeholder="UN1T"
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1.5">From Email</label>
                  <input
                    type="email"
                    value={fromEmail}
                    onChange={e => setFromEmail(e.target.value)}
                    placeholder="hello@un1t.ie"
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm mb-1.5">Reply-To Email</label>
                <input
                  type="email"
                  value={replyTo}
                  onChange={e => setReplyTo(e.target.value)}
                  placeholder="Same as From if left empty"
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                />
              </div>
            </div>

            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider mb-3">Merge Tags</h3>
              <p className="text-xs text-un1t-muted mb-3">Use these in your subject line or email body for personalisation:</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {MERGE_TAG_REFERENCE.map(([tag, desc]) => (
                  <div key={tag} className="flex items-center gap-2 p-2 bg-un1t-surface rounded">
                    <code className="text-blue-700">{tag}</code>
                    <span className="text-un1t-muted">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
