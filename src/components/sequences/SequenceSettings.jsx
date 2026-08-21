'use client'

// FLOW-GRAPH Phase 2 (PR3c-5) — sequence settings + TRIGGER editor inside the
// builder, so operators never need the classic editor. Saves via the existing
// PUT /api/sequences/[id]. trigger_config keys match exactly what the runner
// reads (src/lib/sequences/triggers.js + cron-triggers.js) — verified per type.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Save, Check, AlertTriangle, Settings as SettingsIcon, RefreshCw, Copy } from 'lucide-react'
import { Button } from '@/components/ui'
import { Labeled, Text, Area, Num, Select } from './nodeEditing'
import AudienceBuilder from '@/components/AudienceBuilder'
import AudienceCount from '@/components/communications/AudienceCount'
import {
  ANNIVERSARY_FROM_FIELD_OPTIONS,
  DEFAULT_ANNIVERSARY_FROM_FIELD,
  SUGGESTED_ANNIVERSARY_FROM_FIELD,
  UNRELIABLE_ANNIVERSARY_FIELD_WARNINGS,
  isUnreliableAnniversaryFromField,
} from '@/lib/sequences/anniversary-fields'

const PIPELINE_SLUGS = [
  'new_lead', 'first_class', 'second_class', 'trial_done',
  'converted', 'member', 'pack_member', 'classpass', 'cold_lead', 'dormant',
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// SEQEXIT.1 — the audience stopped being an entry gate and became a
// continuing condition. The field looks identical, so the new meaning has
// to be stated next to it; operators cannot infer it from an unchanged UI.
export const AUDIENCE_CONTINUOUS_HINT =
  'These conditions are checked again before every step, not just at enrolment — a contact who stops matching leaves the sequence.'

// Friendly labels for the engine's trigger vocabulary (must stay in sync with
// schema.js TRIGGER_TYPES / the PUT route enum / the runner).
const TRIGGER_OPTIONS = [
  ['manual', 'Manual — you enrol contacts yourself'],
  ['audience_match', 'Everyone who matches the audience below — and anyone who starts matching later'],
  ['contact_created', 'When a new lead is created'],
  ['booking_created', 'When a booking is created'],
  ['first_booking', 'On a contact’s first booking'],
  ['pipeline_stage_change', 'When the pipeline stage changes'],
  ['tag_added', 'When a tag is added'],
  ['event_reminder', 'Before a booking (reminder)'],
  ['segment_added', 'When a contact enters a segment'],
  ['segment_removed', 'When a contact leaves a segment'],
  ['membership_state_change', 'When the membership state changes (active / paused / locked)'],
  ['anniversary', 'On an anniversary date'],
  ['inactivity', 'After a period of inactivity'],
  ['race_registered', 'When a contact registers for a race'],
  ['race_finished', 'When a contact finishes a race'],
  ['order_completed', 'When an order completes'],
  ['order_failed', 'When an order fails'],
  ['order_abandoned', 'When an order is abandoned'],
  ['achievement_unlocked', 'When an achievement is unlocked'],
  ['webhook', 'When an inbound webhook fires'],
]
// COMMSFIX.E.3 — must mirror the cron's whitelist (cron-triggers.js
// runAnniversaryTriggers): an option offered here but not allowed there is
// rejected at run time with a logged error (no silent fallback any more).
// GAPS-P3.2 — so stop restating it. The list is imported from
// ./anniversary-fields.js, which the runner also imports; a test renders
// this select and asserts the option values equal that list exactly.
// The constant lives in its own import-free module rather than in
// cron-triggers.js because this is a client component and that module
// pulls createServerClient + the whole enrol path.
const ANNIV_FIELDS = ANNIVERSARY_FROM_FIELD_OPTIONS
const INACT_SIGNALS = [['last_emailed_at', 'Last emailed'], ['last_email_open_at', 'Last email open'], ['last_booking_at', 'Last booking']]
const STAGE_OPTS = [['', 'Any stage'], ...PIPELINE_SLUGS.map(s => [s, s])]
// Glofox membership states (mig 195). 'locked' = payment arrears (churn radar's Overdue tab).
const STATE_OPTS = [['', 'Any state'], ['active', 'active'], ['paused', 'paused'], ['locked', 'locked (arrears)']]
// SEQGAPS.1 — same vocabulary for the membership_state GOAL, minus the
// '' / "Any state" entry: a goal with no value is the unconfigured goal
// isGoalMet deliberately refuses to act on, so it must not be selectable.
const GOAL_STATE_OPTS = STATE_OPTS.filter(([v]) => v !== '')

export default function SequenceSettings({ sequence }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(sequence?.name || '')
  const [status, setStatus] = useState(sequence?.status || 'draft')
  const [description, setDescription] = useState(sequence?.description || '')
  const [goal, setGoal] = useState(sequence?.goal_config || null)
  const [windowOn, setWindowOn] = useState(!!sequence?.send_window)
  const [win, setWin] = useState(sequence?.send_window || { start_hour: 9, end_hour: 20, skip_days: [] })
  const [cooldown, setCooldown] = useState(sequence?.re_enrolment_cooldown_days ?? 0)
  const [triggerType, setTriggerType] = useState(sequence?.trigger_type || 'manual')
  const [tcfg, setTcfg] = useState(sequence?.trigger_config || {})
  const [audienceFilter, setAudienceFilter] = useState(sequence?.audience_filter || null)
  const [webhookToken, setWebhookToken] = useState(sequence?.webhook_token || null)
  const [webhookSecret, setWebhookSecret] = useState(sequence?.webhook_secret || '')
  const [origin, setOrigin] = useState('')
  const [segments, setSegments] = useState([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(null) // 'save' | 'rotate' | null
  const [feedback, setFeedback] = useState(null)

  useEffect(() => { if (typeof window !== 'undefined') setOrigin(window.location.origin) }, [])
  useEffect(() => {
    const loc = sequence?.location_id
    if (!loc) return
    let active = true
    fetch(`/api/contacts/segments?location_id=${loc}`)
      .then(r => r.json())
      .then(d => { if (active && d?.success && Array.isArray(d.segments)) setSegments(d.segments) })
      .catch(() => {})
    return () => { active = false }
  }, [sequence?.location_id])

  const touch = () => { setDirty(true); setFeedback(null) }
  const goalType = goal?.type || ''
  // Seed a value the moment a value-bearing type is picked, so the saved
  // config is never "type set, value missing" (which the runner treats as
  // unconfigured and never exits anyone on).
  const setGoalType = (t) => {
    const seed = t === 'pipeline_stage' ? { value: PIPELINE_SLUGS[0] }
      : t === 'membership_state' ? { value: 'active' }
        : {}
    setGoal(t === '' ? null : { type: t, ...seed }); touch()
  }
  const setCfg = (patch) => { setTcfg(prev => ({ ...prev, ...patch })); touch() }

  // ANNIVSAFE.1 — picking the anniversary trigger SEEDS from_field, the same
  // way setGoalType seeds a goal value above and for the same reason: an
  // operator who never touches the dropdown otherwise saves a trigger_config
  // with no from_field, and the runner's legacy default for that is
  // lead_created_at, the CRM import stamp. The dropdown shows what gets saved
  // before it is saved. An EXISTING sequence is left alone — showing it
  // joined_at when the runner will use lead_created_at would be a nicer lie
  // than the one this replaces, so those render the warning instead.
  const changeTrigger = (v) => {
    setTriggerType(v)
    if (v === 'anniversary') {
      setTcfg(prev => (prev?.from_field ? prev : { ...prev, from_field: SUGGESTED_ANNIVERSARY_FROM_FIELD }))
    }
    touch()
  }

  const annivFromField = tcfg.from_field || DEFAULT_ANNIVERSARY_FROM_FIELD
  const annivWarning = isUnreliableAnniversaryFromField(annivFromField)
    ? UNRELIABLE_ANNIVERSARY_FIELD_WARNINGS[annivFromField]
    : null
  const toggleSkipDay = (d) => {
    const cur = new Set(win.skip_days || [])
    cur.has(d) ? cur.delete(d) : cur.add(d)
    setWin({ ...win, skip_days: [...cur].sort((a, b) => a - b) }); touch()
  }

  const buildPayload = () => ({
    name: name || 'Untitled Sequence',
    status,
    description: description || null,
    goal_config: goal,
    send_window: windowOn ? win : null,
    re_enrolment_cooldown_days: Math.max(0, Math.min(3650, parseInt(cooldown, 10) || 0)),
    trigger_type: triggerType,
    trigger_config: tcfg || {},
    audience_filter: (audienceFilter?.filters?.length) ? audienceFilter : null,
    ...(triggerType === 'webhook' ? { webhook_secret: webhookSecret || null } : {}),
  })

  const save = async () => {
    setBusy('save')
    try {
      const res = await fetch(`/api/sequences/${sequence.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload()) })
      const data = await res.json()
      if (data.success) {
        setDirty(false); setFeedback({ ok: true, text: 'Settings saved' })
        if (data.sequence?.webhook_token) setWebhookToken(data.sequence.webhook_token)
      } else setFeedback({ ok: false, text: data.error || 'Could not save settings' })
    } catch { setFeedback({ ok: false, text: 'Network error saving settings' }) } finally { setBusy(null) }
  }

  const regenerateToken = async () => {
    setBusy('rotate')
    try {
      const res = await fetch(`/api/sequences/${sequence.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger_type: 'webhook', rotate_webhook_token: true }) })
      const data = await res.json()
      if (data.success && data.sequence?.webhook_token) { setWebhookToken(data.sequence.webhook_token); setFeedback({ ok: true, text: 'New webhook URL generated' }) }
      else setFeedback({ ok: false, text: data.error || 'Could not regenerate' })
    } catch { setFeedback({ ok: false, text: 'Network error' }) } finally { setBusy(null) }
  }

  const webhookUrl = webhookToken ? `${origin}/api/webhooks/sequence/${webhookToken}` : null

  return (
    <div className="max-w-md mx-auto mb-4 border border-un1t-border rounded-lg bg-un1t-surface">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown size={15} className="text-un1t-subtle" /> : <ChevronRight size={15} className="text-un1t-subtle" />}
        <SettingsIcon size={15} className="text-un1t-subtle" />
        <span className="text-sm font-medium text-un1t-text">Settings &amp; trigger</span>
        <span className="ml-auto text-xs text-un1t-subtle capitalize">{status}{dirty ? ' • unsaved' : ''}</span>
      </button>
      {open && (
        <div className="border-t border-un1t-border px-4 py-3 space-y-3">
          <Labeled label="Name"><Text value={name} onChange={v => { setName(v); touch() }} placeholder="Sequence name" /></Labeled>
          <Labeled label="Status">
            <Select value={status} onChange={v => { setStatus(v); touch() }} options={[['draft', 'Draft'], ['active', 'Active'], ['paused', 'Paused'], ['archived', 'Archived']]} />
          </Labeled>

          {/* Trigger */}
          <div className="rounded-lg border border-un1t-border/70 bg-un1t-bg/40 p-3 space-y-2">
            <Labeled label="Trigger — what starts this flow">
              <Select value={triggerType} onChange={changeTrigger} options={TRIGGER_OPTIONS} />
            </Labeled>
            {triggerType === 'audience_match' && (
              <p className="text-[11px] text-un1t-subtle leading-relaxed">
                The audience below becomes the enrolment rule. Publishing enrols <span className="font-semibold">nobody</span> —
                you start it once, from this page, after seeing how many people it would reach.
                From then on anyone who starts matching is enrolled automatically, within five
                minutes, and you never have to come back. Editing the audience asks you to confirm
                the new number before it starts again.
              </p>
            )}
            {triggerType === 'contact_created' && (
              <p className="text-[11px] text-un1t-subtle leading-relaxed">
                Fires when a lead is created by staff in the CRM, through the website form, by the
                assistant, or in Glofox (new-lead webhook, within seconds). It does <span className="font-semibold">not</span> fire
                for CSV imports or the nightly Glofox bulk sync — those are mass-creates and would
                enrol everyone at once.
              </p>
            )}
            {(triggerType === 'booking_created' || triggerType === 'first_booking') && (
              <Labeled label="Event type ID" hint="Optional — blank means any event type."><Text value={tcfg.event_type_id} onChange={v => setCfg({ event_type_id: v || undefined })} placeholder="event type id (optional)" /></Labeled>
            )}
            {triggerType === 'pipeline_stage_change' && (
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="From stage"><Select value={tcfg.from_status || ''} onChange={v => setCfg({ from_status: v || undefined })} options={STAGE_OPTS} /></Labeled>
                <Labeled label="To stage"><Select value={tcfg.to_status || ''} onChange={v => setCfg({ to_status: v || undefined })} options={STAGE_OPTS} /></Labeled>
              </div>
            )}
            {triggerType === 'tag_added' && (
              <Labeled label="Tag" hint="Fires when this exact tag is added."><Text value={tcfg.tag} onChange={v => setCfg({ tag: v })} placeholder="e.g. trial_expired" /></Labeled>
            )}
            {triggerType === 'event_reminder' && (
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Hours before"><Num value={tcfg.hours_before ?? 24} onChange={v => setCfg({ hours_before: v })} max={2160} /></Labeled>
                <Labeled label="Event type ID" hint="Optional"><Text value={tcfg.event_type_id} onChange={v => setCfg({ event_type_id: v || undefined })} placeholder="optional" /></Labeled>
              </div>
            )}
            {(triggerType === 'segment_added' || triggerType === 'segment_removed') && (
              <div>
                <Labeled label="Segment" hint={segments.length ? 'A saved contact segment.' : null}>
                  <Select value={tcfg.segment_id || ''} onChange={v => setCfg({ segment_id: v || undefined })} options={[['', 'Choose a segment…'], ...segments.map(s => [s.id, s.name])]} />
                </Labeled>
                {segments.length === 0 && (
                  <p className="text-[11px] text-un1t-subtle/80 mt-1">No saved segments yet — <Link href="/contacts" className="text-un1t-text underline hover:no-underline">create one on Contacts</Link>, or gate by a contact attribute with the Audience conditions below.</p>
                )}
              </div>
            )}
            {triggerType === 'membership_state_change' && (
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="From state"><Select value={tcfg.from_state || ''} onChange={v => setCfg({ from_state: v || undefined })} options={STATE_OPTS} /></Labeled>
                <Labeled label="To state" hint="e.g. → locked starts a dunning flow."><Select value={tcfg.to_state || ''} onChange={v => setCfg({ to_state: v || undefined })} options={STATE_OPTS} /></Labeled>
              </div>
            )}
            {triggerType === 'anniversary' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Labeled label="Anniversary of"><Select value={annivFromField} onChange={v => setCfg({ from_field: v })} options={ANNIV_FIELDS} /></Labeled>
                  <Labeled label="Days after"><Num value={tcfg.days_after ?? 365} onChange={v => setCfg({ days_after: v })} max={3650} /></Labeled>
                </div>
                {annivWarning && (
                  <p
                    data-testid="anniversary-field-warning"
                    className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700"
                  >
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{annivWarning}</span>
                  </p>
                )}
              </div>
            )}
            {triggerType === 'inactivity' && (
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="No activity on"><Select value={tcfg.signal || 'last_emailed_at'} onChange={v => setCfg({ signal: v })} options={INACT_SIGNALS} /></Labeled>
                <Labeled label="Days inactive"><Num value={tcfg.days_inactive ?? 30} onChange={v => setCfg({ days_inactive: v })} max={3650} /></Labeled>
              </div>
            )}
            {(triggerType === 'race_registered' || triggerType === 'race_finished') && (
              <Labeled label="Race event ID" hint="Optional — blank means any race."><Text value={tcfg.race_event_id} onChange={v => setCfg({ race_event_id: v || undefined })} placeholder="optional" /></Labeled>
            )}
            {triggerType === 'achievement_unlocked' && (
              <Labeled label="Achievement rule slug" hint="Optional — blank means any achievement."><Text value={tcfg.rule_slug} onChange={v => setCfg({ rule_slug: v || undefined })} placeholder="optional" /></Labeled>
            )}
            {triggerType === 'webhook' && (
              <div className="space-y-2">
                {webhookUrl ? (
                  <div>
                    <span className="block text-xs font-medium text-un1t-subtle mb-1">Inbound webhook URL</span>
                    <div className="flex items-center gap-1">
                      <code className="flex-1 text-[11px] bg-un1t-bg border border-un1t-border rounded px-2 py-1.5 text-un1t-text truncate">{webhookUrl}</code>
                      <button type="button" title="Copy" onClick={() => navigator.clipboard?.writeText(webhookUrl)} className="w-7 h-7 rounded-md flex items-center justify-center text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/40"><Copy size={13} /></button>
                      <button type="button" title="Regenerate (invalidates the old URL)" onClick={regenerateToken} disabled={busy !== null} className="w-7 h-7 rounded-md flex items-center justify-center text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/40 disabled:opacity-40"><RefreshCw size={13} className={busy === 'rotate' ? 'animate-spin' : ''} /></button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-un1t-subtle">Save to generate the inbound webhook URL.</p>
                )}
                <Labeled label="Shared secret" hint="Optional — sent as the webhook signature; blank = token-in-URL only."><Text value={webhookSecret} onChange={v => { setWebhookSecret(v); touch() }} placeholder="optional secret" /></Labeled>
              </div>
            )}
          </div>

          {/* Audience — who is eligible to enter */}
          <div className="rounded-lg border border-un1t-border/70 bg-un1t-bg/40 p-3 space-y-2">
            <div>
              {/* SEQEXIT.1 — the old label said "who can enter", which is now the
                  wrong mental model: the same conditions also decide who STAYS. */}
              <span className="block text-xs font-medium text-un1t-subtle">Audience — who this applies to</span>
              <span className="block text-[11px] text-un1t-subtle/80">Only enrol contacts who match these conditions when the trigger fires. Leave empty to allow anyone.</span>
              <span className="block text-[11px] text-un1t-subtle/80 mt-1">{AUDIENCE_CONTINUOUS_HINT}</span>
            </div>
            <AudienceBuilder filter={audienceFilter || { logic: 'and', filters: [] }} onChange={f => { setAudienceFilter(f); touch() }} />
            {/* FILTER-B.3 — a MATCHING count, deliberately not a send count.
                Since SEQEXIT.1 this filter is a continuing condition: it
                decides who enrols AND who stays, re-checked before every
                step. "N will receive it" would be a recipient count for a
                send that does not exist, so mode="matching" asks
                channel-agnostically and labels the number honestly. */}
            {sequence?.location_id && (
              <AudienceCount
                className="mt-2"
                locationId={sequence.location_id}
                filter={audienceFilter || { logic: 'and', filters: [] }}
                mode="matching"
              />
            )}
          </div>

          {/* Goal */}
          <Labeled label="Goal — auto-exit when…" hint="The contact leaves the sequence early once this is met.">
            <Select value={goalType} onChange={setGoalType} options={[['', 'No goal'], ['pipeline_stage', 'Reaches a pipeline stage'], ['membership_state', 'Reaches a membership state'], ['tag_added', 'Gets a tag'], ['booked_since_enrolment', 'Books a class'], ['booking_made', 'Books an event']]} />
          </Labeled>
          {goalType === 'booked_since_enrolment' && (
            <p className="text-xs text-un1t-subtle">
              Exits when the contact books a Glofox class <em>after</em> joining this sequence. Use this for
              any chase whose audience can include people who have trained here before — a “first booking”
              tag only ever fires once per contact, so it cannot end their chase.
            </p>
          )}
          {goalType === 'pipeline_stage' && (
            <Labeled label="Stage"><Select value={goal.value || PIPELINE_SLUGS[0]} onChange={v => { setGoal({ ...goal, value: v }); touch() }} options={PIPELINE_SLUGS} /></Labeled>
          )}
          {goalType === 'membership_state' && (
            <Labeled label="Membership state" hint="For a dunning flow, pick active — paying is a win, so the exit is recorded as “Goal met”, not a drop-out.">
              <Select value={goal.value || 'active'} onChange={v => { setGoal({ ...goal, value: v }); touch() }} options={GOAL_STATE_OPTS} />
            </Labeled>
          )}
          {goalType === 'tag_added' && (
            <Labeled label="Tag"><Text value={goal.tag} onChange={v => { setGoal({ ...goal, tag: v }); touch() }} placeholder="e.g. race_completed" /></Labeled>
          )}

          {/* Send window */}
          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-un1t-subtle">
              <input type="checkbox" checked={windowOn} onChange={e => { setWindowOn(e.target.checked); touch() }} />
              Only send during set hours
            </label>
            {windowOn && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Labeled label="From (hour, 0–23)"><Num value={win.start_hour} onChange={v => { setWin({ ...win, start_hour: v }); touch() }} max={23} /></Labeled>
                  <Labeled label="To (hour, 0–23)"><Num value={win.end_hour} onChange={v => { setWin({ ...win, end_hour: v }); touch() }} max={23} /></Labeled>
                </div>
                <div>
                  <span className="block text-xs font-medium text-un1t-subtle mb-1">Skip days</span>
                  <div className="flex gap-1">
                    {DAYS.map((d, i) => (
                      <button key={i} type="button" onClick={() => toggleSkipDay(i)}
                        className={`px-2 py-1 rounded text-xs transition-colors ${(win.skip_days || []).includes(i) ? 'bg-rose-500/15 text-rose-700' : 'bg-un1t-border/40 text-un1t-subtle hover:text-un1t-text'}`}>{d}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <Labeled label="Re-enrolment cooldown (days)" hint="0 = enrol each contact once. N = they can re-enter after N days.">
            <Num value={cooldown} onChange={v => { setCooldown(v); touch() }} max={3650} />
          </Labeled>
          <Labeled label="Internal note"><Area value={description} onChange={v => { setDescription(v); touch() }} rows={2} placeholder="Optional memo for your team" /></Labeled>

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={save} variant="primary" size="sm" icon={Save} loading={busy === 'save'} disabled={!dirty || busy !== null}>Save settings</Button>
            {feedback && <span className={`text-xs flex items-center gap-1 ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{feedback.ok ? <Check size={13} /> : <AlertTriangle size={13} />}{feedback.text}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
