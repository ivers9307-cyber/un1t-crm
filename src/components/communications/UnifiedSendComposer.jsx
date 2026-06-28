'use client'

// PILLAR2 Phase 1 — the unified, audience-first "send a message off the cuff"
// surface. One screen: pick audience → pick channel → compose → send now (or
// schedule, SMS only). It's a FACADE: on send it creates the existing
// per-channel broadcast record and fires the existing send route — the send
// libs + crons are untouched. Email joins in Phase 2.
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MessageSquare, MessageCircle, Mail, Send, Clock, Check, AlertTriangle, Users, Loader2, Filter } from 'lucide-react'
import { Button } from '@/components/ui'
import AudienceBuilder from '@/components/AudienceBuilder'
import ContactMultiSelect from './ContactMultiSelect'
import { useUnlayerEditor } from './useUnlayerEditor'
import { smsSegmentInfo, SMS_MAX_LEN, SMS_MERGE_TAGS, waBodyVariables, WA_VARIABLE_FIELDS } from '@/lib/communications/compose'

const EMPTY_FILTER = { logic: 'and', filters: [] }

const fieldCls =
  'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

export default function UnifiedSendComposer({ locationId, channels = [], templates = [], initialAudienceFilter = null }) {
  const router = useRouter()
  const [channel, setChannel] = useState(channels[0] || 'sms')
  const [label, setLabel] = useState('')
  const [filter, setFilter] = useState(initialAudienceFilter || EMPTY_FILTER)
  // Explicit "pick people" mode (SMS / WhatsApp only)
  const [audienceMode, setAudienceMode] = useState('filter') // 'filter' | 'people'
  const [people, setPeople] = useState([]) // [{ id, name, email, phone }]
  // SMS
  const [body, setBody] = useState('')
  const bodyRef = useRef(null)
  // Email
  const [subject, setSubject] = useState('')
  const [emailType, setEmailType] = useState('marketing') // 'marketing' | 'utility'
  // WhatsApp
  const [templateId, setTemplateId] = useState('')
  const [variables, setVariables] = useState({})
  // WhatsApp pacing (WA-DRIP)
  const [waMode, setWaMode] = useState('blast') // 'blast' | 'drip'
  const [dailyCap, setDailyCap] = useState(500)
  const [perTickCap, setPerTickCap] = useState('') // blank = code default (100/tick)
  const [windowStart, setWindowStart] = useState('09:00')
  const [windowEnd, setWindowEnd] = useState('20:00')
  // Schedule (SMS only)
  const [scheduleMode, setScheduleMode] = useState('now') // 'now' | 'later'
  const [scheduledAtLocal, setScheduledAtLocal] = useState('')
  // Audience count (debounced)
  const [count, setCount] = useState(null)
  const [counting, setCounting] = useState(false)
  const [reachable, setReachable] = useState(null)   // WhatsApp only
  const [excluded, setExcluded] = useState(null)     // { no_number, no_consent, opted_out }
  // Submit
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const selectedTemplate = useMemo(() => templates.find(t => t.id === templateId) || null, [templates, templateId])
  const waVars = useMemo(() => waBodyVariables(selectedTemplate), [selectedTemplate])
  const seg = smsSegmentInfo(body)

  // Explicit "pick people" mode is SMS/WhatsApp only — email hands off to the
  // campaign editor, whose AudienceBuilder can't represent an id-in filter yet.
  const useExplicit = audienceMode === 'people' && channel !== 'email'
  const effectiveFilter = useMemo(() => (
    useExplicit
      ? { logic: 'and', filters: [{ field: 'id', op: 'in', value: people.map(p => p.id) }] }
      : filter
  ), [useExplicit, people, filter])

  // Inline Unlayer editor for the email channel (the full editor stays at
  // /email/campaigns/[id] for advanced options: from-name, preview text, test send).
  const { ref: unlayerRef, loaded: unlayerLoaded, exportHtml: exportEmailHtml } = useUnlayerEditor({ mountId: 'unlayer-editor-composer', active: channel === 'email' })

  // Live audience size — debounced. For WhatsApp we ask channel-aware so the
  // number reflects consent + a usable wa_phone (the same gate the send applies).
  useEffect(() => {
    let alive = true
    setCounting(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/communications/audience-count', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: locationId, audience_filter: effectiveFilter, channel }),
        })
        const data = await res.json()
        if (!alive) return
        setCount(data?.success ? data.count : null)
        setReachable(data?.success && channel === 'whatsapp' ? (data.reachable ?? null) : null)
        setExcluded(data?.success && channel === 'whatsapp' ? (data.excluded ?? null) : null)
      } catch {
        if (alive) { setCount(null); setReachable(null); setExcluded(null) }
      } finally {
        if (alive) setCounting(false)
      }
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [locationId, effectiveFilter, channel])

  const insertTag = (tag) => {
    const el = bodyRef.current
    if (!el) { setBody(b => b + tag); return }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    setBody(body.slice(0, start) + tag + body.slice(end))
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + tag.length })
  }

  const defaultLabel = () => {
    const ch = channel === 'sms' ? 'SMS' : channel === 'whatsapp' ? 'WhatsApp' : 'Email'
    return label.trim() || `${ch} — ${new Date().toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })}`
  }

  // ── validation ──────────────────────────────────────────────────
  const scheduledIso = scheduledAtLocal ? new Date(scheduledAtLocal).toISOString() : null
  const scheduleValid = scheduleMode === 'now' || (scheduledIso && new Date(scheduledIso).getTime() > Date.now())
  const composeValid = channel === 'sms'
    ? (body.trim().length > 0 && body.length <= SMS_MAX_LEN)
    : channel === 'whatsapp'
      ? !!templateId
      : subject.trim().length > 0 // email — needs a subject (design is inline)
  const audienceValid = !useExplicit || people.length > 0
  const isSchedule = scheduleMode === 'later' && (channel === 'sms' || channel === 'email')
  const isDrip = channel === 'whatsapp' && waMode === 'drip'
  // For WhatsApp the meaningful gate is the reachable count, not raw matches —
  // an audience of 1 with 0 reachable has nobody to send to.
  const sendableCount = channel === 'whatsapp' ? reachable : count
  const canSend = !busy && composeValid && scheduleValid && audienceValid && (sendableCount == null || sendableCount > 0)

  // ── submit ──────────────────────────────────────────────────────
  async function postJson(url, payload) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok || data?.success === false) throw new Error(data?.error || `Request failed (${res.status})`)
    return data
  }

  async function send() {
    setBusy(true); setError(null); setResult(null)
    try {
      if (channel === 'sms') {
        const { broadcast } = await postJson('/api/sms/broadcasts', {
          name: defaultLabel(), body, audience_filter: effectiveFilter, location_id: locationId,
          ...(scheduleMode === 'later' ? { scheduled_at: scheduledIso } : {}),
        })
        if (scheduleMode === 'later') {
          const res = await fetch(`/api/sms/broadcasts/${broadcast.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'scheduled', scheduled_at: scheduledIso }),
          })
          const data = await res.json()
          if (!res.ok || data?.success === false) throw new Error(data?.error || 'Could not schedule')
          setResult({ channel, mode: 'scheduled', when: scheduledIso, id: broadcast.id, detail: `/communications/sms/broadcasts/${broadcast.id}` })
        } else {
          const data = await postJson(`/api/sms/broadcasts/${broadcast.id}/send`, {})
          setResult({ channel, mode: 'sent', id: broadcast.id, detail: `/communications/sms/broadcasts/${broadcast.id}`, ...data })
        }
      } else if (channel === 'whatsapp') {
        const drip = waMode === 'drip'
        const { broadcast } = await postJson('/api/whatsapp/broadcasts', {
          name: defaultLabel(), template_id: templateId, variable_mapping: variables,
          audience_filter: effectiveFilter, location_id: locationId,
          delivery_mode: waMode,
          ...(drip ? {
            daily_cap: Number(dailyCap) || 500,
            ...(Number(perTickCap) > 0 ? { per_tick_max: Number(perTickCap) } : {}),
            send_window_start: windowStart, send_window_end: windowEnd,
            send_window_tz: 'Europe/Dublin',
          } : {}),
        })
        if (drip) {
          // Create set status='sending'; the run-whatsapp-broadcasts cron drives
          // it during the window. No /send call for a drip.
          setResult({ channel, mode: 'drip', id: broadcast.id, detail: `/whatsapp/broadcasts/${broadcast.id}`,
            dailyCap: Number(dailyCap) || 500, windowStart, windowEnd })
        } else {
          const data = await postJson(`/api/whatsapp/broadcasts/${broadcast.id}/send`, {})
          setResult({ channel, mode: 'sent', id: broadcast.id, detail: `/whatsapp/broadcasts/${broadcast.id}`, ...data })
        }
      } else {
        // Email — design inline with Unlayer, create the campaign, then queue
        // (send-now) or schedule it. The run-campaigns cron does the actual send
        // (the send path is untouched).
        const { html, design } = await exportEmailHtml()
        const action = scheduleMode === 'later' ? 'schedule' : 'send'
        const data = await postJson('/api/communications/email-draft', {
          name: defaultLabel(), subject, audience_filter: effectiveFilter, location_id: locationId,
          html_content: html, design_json: design, action, email_type: emailType,
          ...(action === 'schedule' ? { scheduled_at: scheduledIso } : {}),
        })
        setResult({
          channel, id: data.id, detail: `/email/campaigns/${data.id}`,
          mode: action === 'schedule' ? 'scheduled' : 'sent', when: scheduledIso, queued: action === 'send',
        })
      }
    } catch (e) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  // Email power-user escape hatch: save the inline design as a draft and open the
  // full campaign editor (from-name, preview text, code mode, test send).
  async function openFullEditor() {
    setBusy(true); setError(null)
    try {
      const { html, design } = await exportEmailHtml()
      const data = await postJson('/api/communications/email-draft', {
        name: defaultLabel(), subject, audience_filter: effectiveFilter, location_id: locationId,
        html_content: html, design_json: design, action: 'draft', email_type: emailType,
      })
      router.push(`/email/campaigns/${data.id}?edit=1`)
    } catch (e) { setError(e?.message || 'Could not open the editor'); setBusy(false) }
  }

  function reset() {
    setResult(null); setError(null); setBody(''); setTemplateId(''); setVariables({})
    setLabel(''); setFilter(EMPTY_FILTER); setScheduleMode('now'); setScheduledAtLocal('')
    setWaMode('blast'); setDailyCap(500); setPerTickCap(''); setWindowStart('09:00'); setWindowEnd('20:00')
    setReachable(null); setExcluded(null)
  }

  // ── result screen ───────────────────────────────────────────────
  if (result) {
    return (
      <div className="max-w-xl mx-auto mt-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.05] p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-500/15 text-emerald-700 flex items-center justify-center mx-auto mb-3">
          {result.mode === 'scheduled' || result.mode === 'drip' ? <Clock size={22} /> : <Check size={22} />}
        </div>
        {result.mode === 'drip' ? (
          <>
            <h2 className="text-lg font-semibold text-un1t-text">Drip started</h2>
            <p className="text-sm text-un1t-subtle mt-1">
              Up to {result.dailyCap}/day will go out between {result.windowStart} and {result.windowEnd} (Europe/Dublin)
              until everyone&apos;s been messaged. Pause or track progress on the details page.
            </p>
          </>
        ) : result.mode === 'scheduled' ? (
          <>
            <h2 className="text-lg font-semibold text-un1t-text">Scheduled</h2>
            <p className="text-sm text-un1t-subtle mt-1">
              Your {result.channel === 'sms' ? 'SMS' : 'WhatsApp'} will go out at{' '}
              {new Date(result.when).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })}.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-un1t-text">
              {result.queued
                ? 'Queued'
                : result.channel === 'whatsapp' && (result.sent ?? 0) === 0 && result.remaining ? 'Sending…'
                : result.channel === 'whatsapp' && (result.sent ?? 0) === 0 ? 'Nobody was reachable'
                : (result.remaining > 0 ? 'Sending…' : 'Sent')}
            </h2>
            <p className="text-sm text-un1t-subtle mt-1">
              {result.queued
                ? 'Your email is queued — it goes out within the next minute.'
                : (() => {
                    const ds = result.delivery_summary
                    const k = ds ? (ds.matched - ds.reachable) : null
                    const reasons = ds && ds.excluded ? [
                      ds.excluded.no_number ? `${ds.excluded.no_number} no WhatsApp number` : null,
                      ds.excluded.no_consent ? `${ds.excluded.no_consent} no marketing opt-in` : null,
                      ds.excluded.opted_out ? `${ds.excluded.opted_out} opted out` : null,
                      ds.excluded.undeliverable ? `${ds.excluded.undeliverable} not on WhatsApp` : null,
                    ].filter(Boolean).join(', ') : ''
                    if (result.channel === 'whatsapp' && (result.sent ?? 0) === 0 && !result.remaining) {
                      return reasons
                        ? `None of the ${ds.matched} matched contacts could be messaged — ${reasons}.`
                        : 'None of the matched contacts could be messaged on WhatsApp.'
                    }
                    return <>
                      {`${result.sent ?? result.total ?? 0} sent`}
                      {result.failed ? `, ${result.failed} failed` : ''}
                      {result.recipients != null ? ` of ${result.recipients}` : ''}
                      {k > 0 ? ` · ${k} excluded${reasons ? ` (${reasons})` : ''}` : ''}
                      {result.remaining > 0 ? ' — the rest go out automatically over the next few minutes.' : '.'}
                    </>
                  })()}
            </p>
          </>
        )}
        <div className="flex items-center justify-center gap-2 mt-5">
          <Button onClick={reset} variant="primary" size="sm" icon={Send}>Send another</Button>
          {result.detail && (
            <Link href={result.detail} className="text-sm text-un1t-subtle hover:text-un1t-text underline">View details</Link>
          )}
        </div>
      </div>
    )
  }

  // ── composer ────────────────────────────────────────────────────
  return (
    <div className={`${channel === 'email' ? 'max-w-5xl' : 'max-w-2xl'} mx-auto space-y-5`}>
      {/* Channel */}
      {channels.length > 1 && (
        <div className="flex gap-2">
          {channels.includes('sms') && (
            <ChannelPill active={channel === 'sms'} onClick={() => setChannel('sms')} icon={MessageSquare} label="SMS" />
          )}
          {channels.includes('whatsapp') && (
            <ChannelPill active={channel === 'whatsapp'} onClick={() => setChannel('whatsapp')} icon={MessageCircle} label="WhatsApp" />
          )}
          {channels.includes('email') && (
            <ChannelPill active={channel === 'email'} onClick={() => setChannel('email')} icon={Mail} label="Email" />
          )}
        </div>
      )}

      {/* Audience */}
      <Section title="Who" sub="Build a filter / pick a saved segment, or choose specific people. Consent + reachability are applied automatically when you send.">
        {channel !== 'email' && (
          <div className="flex gap-2 mb-3">
            <ChannelPill active={audienceMode === 'filter'} onClick={() => setAudienceMode('filter')} icon={Filter} label="Filter / segment" small />
            <ChannelPill active={audienceMode === 'people'} onClick={() => setAudienceMode('people')} icon={Users} label="Pick people" small />
          </div>
        )}
        {useExplicit
          ? <ContactMultiSelect locationId={locationId} value={people} onChange={setPeople} />
          : <AudienceBuilder filter={filter} onChange={setFilter} />}
        <div className="mt-2 flex flex-col gap-0.5 text-xs text-un1t-subtle">
          <div className="flex items-center gap-1.5">
            <Users size={13} />
            {counting
              ? <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> counting…</span>
              : count == null
                ? <span>Add a condition to see how many contacts match.</span>
                : channel === 'whatsapp'
                  ? <span><b className="text-un1t-text">{count.toLocaleString()}</b> match · <b className="text-un1t-text">{(reachable ?? 0).toLocaleString()}</b> reachable on WhatsApp</span>
                  : <span><b className="text-un1t-text">{count.toLocaleString()}</b> contact{count === 1 ? '' : 's'} match this filter</span>}
          </div>
          {channel === 'whatsapp' && !counting && count != null && reachable != null && (count - reachable) > 0 && (
            <div className="flex items-start gap-1.5 text-amber-700">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {(count - reachable).toLocaleString()} excluded
                {excluded ? ` — ${[
                  excluded.no_number ? `${excluded.no_number} no WhatsApp number` : null,
                  excluded.no_consent ? `${excluded.no_consent} no marketing opt-in` : null,
                  excluded.opted_out ? `${excluded.opted_out} opted out` : null,
                  excluded.undeliverable ? `${excluded.undeliverable} not on WhatsApp` : null,
                ].filter(Boolean).join(', ')}` : ''}
              </span>
            </div>
          )}
        </div>
      </Section>

      {/* Compose */}
      <Section title="Message">
        <label className="block mb-3">
          <span className="block text-xs font-medium text-un1t-subtle mb-1">Label <span className="text-un1t-subtle/60">(optional, internal only)</span></span>
          <input className={fieldCls} value={label} onChange={e => setLabel(e.target.value)} placeholder={defaultLabel()} />
        </label>

        {channel === 'sms' ? (
          <>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {SMS_MERGE_TAGS.map(t => (
                <button key={t.tag} type="button" onClick={() => insertTag(t.tag)}
                  className="text-[11px] px-2 py-1 rounded-md bg-un1t-border/40 text-un1t-subtle hover:text-un1t-text">+ {t.label}</button>
              ))}
            </div>
            <textarea ref={bodyRef} className={`${fieldCls} resize-y`} rows={5} value={body} maxLength={SMS_MAX_LEN}
              onChange={e => setBody(e.target.value)} placeholder="Hi {{first_name}}, …" />
            <div className="mt-1 text-[11px] text-un1t-subtle text-right">
              {seg.len}/{SMS_MAX_LEN} chars · {seg.segments} segment{seg.segments === 1 ? '' : 's'}
            </div>
          </>
        ) : channel === 'whatsapp' ? (
          <>
            <label className="block">
              <span className="block text-xs font-medium text-un1t-subtle mb-1">Approved template</span>
              <select className={fieldCls} value={templateId} onChange={e => { setTemplateId(e.target.value); setVariables({}) }}>
                <option value="">Choose a template…</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}{t.language ? ` (${t.language})` : ''}{t.category ? ` · ${t.category}` : ''}</option>
                ))}
              </select>
            </label>
            {templates.length === 0 && (
              <p className="text-[11px] text-un1t-subtle mt-1">No approved WhatsApp templates at this location yet.</p>
            )}
            {selectedTemplate && (
              <div className="mt-3 rounded-lg border border-un1t-border bg-un1t-bg/40 p-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[11px] uppercase tracking-wider text-un1t-subtle">Preview</p>
                  {['YELLOW', 'RED'].includes(selectedTemplate.quality_rating) && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${selectedTemplate.quality_rating === 'RED' ? 'bg-red-500/15 text-red-700' : 'bg-amber-500/15 text-amber-700'}`}>
                      Quality {selectedTemplate.quality_rating}
                    </span>
                  )}
                </div>
                <p className="text-sm text-un1t-text whitespace-pre-wrap">{(selectedTemplate.components || []).find(c => c.type === 'BODY')?.text || '—'}</p>
              </div>
            )}
            {selectedTemplate && waVars.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-[11px] text-un1t-subtle">Map each variable to a contact field or a literal value.</p>
                {waVars.map(n => (
                  <label key={n} className="block">
                    <span className="block text-xs font-medium text-un1t-subtle mb-1">Variable {`{{${n}}}`}</span>
                    <input className={fieldCls} list="wa-fields" value={variables[n] || ''}
                      onChange={e => setVariables(v => ({ ...v, [n]: e.target.value }))} placeholder="first_name or literal text" />
                  </label>
                ))}
                <datalist id="wa-fields">{WA_VARIABLE_FIELDS.map(f => <option key={f} value={f} />)}</datalist>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mb-3">
              <span className="block text-xs font-medium text-un1t-subtle mb-1">Email type</span>
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
            <label className="block mb-3">
              <span className="block text-xs font-medium text-un1t-subtle mb-1">Subject</span>
              <input className={fieldCls} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Email subject" />
            </label>
            <div id="unlayer-editor-composer" ref={unlayerRef} className="h-[560px] rounded-lg overflow-hidden border border-un1t-border bg-un1t-bg" />
            {!unlayerLoaded && <p className="text-[11px] text-un1t-subtle mt-1">Loading the email designer…</p>}
            <div className="mt-2 text-right">
              <button type="button" onClick={openFullEditor} disabled={busy}
                className="text-[11px] text-un1t-subtle hover:text-un1t-text underline disabled:opacity-40">
                Need from-name, preview text or a test send? Open the full editor →
              </button>
            </div>
          </>
        )}
      </Section>

      {/* Pacing — WhatsApp only (WA-DRIP) */}
      {channel === 'whatsapp' && (
        <Section title="Pacing" sub="Send all at once, or drip a capped number per day until everyone's been messaged — the safe way to work a large list without tripping WhatsApp's per-day limits.">
          <div className="flex gap-2 mb-3">
            <ChannelPill active={waMode === 'blast'} onClick={() => setWaMode('blast')} icon={Send} label="Send now" small />
            <ChannelPill active={waMode === 'drip'} onClick={() => setWaMode('drip')} icon={Clock} label="Drip" small />
          </div>
          {waMode === 'drip' && (
            <div className="space-y-3">
              <label className="block">
                <span className="block text-xs font-medium text-un1t-subtle mb-1">Daily limit (messages per 24h)</span>
                <input type="number" min={1} max={100000} className={fieldCls}
                  value={dailyCap} onChange={e => setDailyCap(e.target.value)} />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-un1t-subtle mb-1">Batch size per run <span className="text-un1t-subtle/60">(optional)</span></span>
                <input type="number" min={1} max={5000} className={fieldCls}
                  value={perTickCap} onChange={e => setPerTickCap(e.target.value)} placeholder="100 (default)" />
                <span className="block text-[11px] text-un1t-subtle mt-1">How many go out each 15-min run. Lower = smoother; blank uses the default (100). The daily limit still caps the 24h total.</span>
              </label>
              <div className="flex gap-3">
                <label className="block flex-1">
                  <span className="block text-xs font-medium text-un1t-subtle mb-1">Send from</span>
                  <input type="time" className={fieldCls} value={windowStart} onChange={e => setWindowStart(e.target.value)} />
                </label>
                <label className="block flex-1">
                  <span className="block text-xs font-medium text-un1t-subtle mb-1">Send until</span>
                  <input type="time" className={fieldCls} value={windowEnd} onChange={e => setWindowEnd(e.target.value)} />
                </label>
              </div>
              <p className="text-[11px] text-un1t-subtle">Europe/Dublin time. The drip pauses overnight and resumes each morning.</p>
            </div>
          )}
        </Section>
      )}

      {/* When — SMS + email support scheduling; WhatsApp sends immediately. */}
      {(channel === 'sms' || channel === 'email') && (
        <Section title="When">
          <div className="flex gap-2 mb-2">
            <ChannelPill active={scheduleMode === 'now'} onClick={() => setScheduleMode('now')} icon={Send} label="Send now" small />
            <ChannelPill active={scheduleMode === 'later'} onClick={() => setScheduleMode('later')} icon={Clock} label="Schedule" small />
          </div>
          {scheduleMode === 'later' && (
            <input type="datetime-local" className={fieldCls} value={scheduledAtLocal} onChange={e => setScheduledAtLocal(e.target.value)} />
          )}
          {scheduleMode === 'later' && scheduledAtLocal && !scheduleValid && (
            <p className="text-[11px] text-rose-700 mt-1">Pick a time in the future.</p>
          )}
        </Section>
      )}

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.05] px-3 py-2 text-sm text-rose-700 flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />{error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={send} variant="primary" icon={isSchedule ? Clock : Send}
          loading={busy} disabled={!canSend}>
          {isSchedule ? 'Schedule' : isDrip ? 'Start drip' : 'Send now'}
        </Button>
        {count === 0 && <span className="text-xs text-amber-700">No contacts match this filter.</span>}
      </div>
    </div>
  )
}

function ChannelPill({ active, onClick, icon: Icon, label, small }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border px-3 ${small ? 'py-1.5' : 'py-2'} text-sm transition-colors ${
        active ? 'border-un1t-text/30 bg-un1t-text/[0.04] text-un1t-text font-medium' : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'}`}>
      <Icon size={15} />{label}
    </button>
  )
}

function Section({ title, sub, children }) {
  return (
    <div className="rounded-2xl border border-un1t-border bg-un1t-surface p-4">
      <h3 className="text-sm font-semibold text-un1t-text">{title}</h3>
      {sub && <p className="text-xs text-un1t-subtle mt-0.5 mb-3">{sub}</p>}
      {!sub && <div className="mb-3" />}
      {children}
    </div>
  )
}
