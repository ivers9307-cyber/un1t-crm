'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Send, Users, CheckCircle2, XCircle, Ban, Clock } from 'lucide-react'
import AudienceBuilder from './AudienceBuilder'
import AudienceCount from './communications/AudienceCount'
import SendQuietHoursNotice from './communications/SendQuietHoursNotice'
import { estimateDripDays } from '@/lib/whatsapp-drip'
import { groupWaTemplates, UNGROUPED_LABEL } from '@shared/wa-template-groups'

export default function WABroadcastEditor({ broadcast, templates, locationId, userId, failedRecipients = [], failedCount = 0, dripProgress = null }) {
  const router = useRouter()
  const isSent = broadcast?.status === 'sent'
  const isCancelled = broadcast?.status === 'cancelled'
  const isTerminal = isSent || isCancelled   // finished (sent or cancelled) → read-only results, not the editor
  const isDripInFlight = broadcast?.delivery_mode === 'drip' && broadcast?.status === 'sending'
  // WA-SCHEDULE — scheduled stays editable (SMS idiom: un-schedule via the
  // same page); the cron promotes it at scheduled_at.
  const isScheduled = broadcast?.status === 'scheduled'

  const [name, setName] = useState(broadcast?.name || '')
  const [templateId, setTemplateId] = useState(broadcast?.template_id || '')
  const [variableMapping, setVariableMapping] = useState(broadcast?.variable_mapping || {})
  const [headerMediaUrl, setHeaderMediaUrl] = useState(broadcast?.header_media_url || '')
  const [audienceFilter, setAudienceFilter] = useState(
    broadcast?.audience_filter || { filters: [], logic: 'and' }
  )
  const [broadcastId, setBroadcastId] = useState(broadcast?.id || null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState(isTerminal ? 'results' : 'setup')
  // Adjust drip pacing on a running drip (mig 328 / WA-DRIP-SIZE).
  const [editingDrip, setEditingDrip] = useState(false)
  const [savingDrip, setSavingDrip] = useState(false)
  const [capInput, setCapInput] = useState(broadcast?.daily_cap || 500)
  const [tickInput, setTickInput] = useState(broadcast?.per_tick_max || '')

  const selectedTemplate = templates.find(t => t.id === templateId)
  const bodyComp = selectedTemplate?.components?.find(c => c.type === 'BODY')
  const headerComp = selectedTemplate?.components?.find(c => c.type === 'HEADER')
  const bodyVars = bodyComp?.text?.match(/\{\{\d+\}\}/g) || []

  const VARIABLE_OPTIONS = [
    { value: 'first_name', label: 'First Name' },
    { value: 'name', label: 'Full Name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'location_name', label: 'Location Name' },
    { value: 'pipeline_stage', label: 'Pipeline Stage' },
  ]

  async function handleSave() {
    setSaving(true)
    setError(null)

    try {
      const payload = {
        name: name || 'Untitled Broadcast',
        template_id: templateId || null,
        variable_mapping: variableMapping,
        header_media_url: headerMediaUrl || null,
        audience_filter: audienceFilter,
        location_id: locationId,
        created_by: userId,
      }

      let result
      if (broadcastId) {
        result = await fetch(`/api/whatsapp/broadcasts/${broadcastId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json())
      } else {
        result = await fetch('/api/whatsapp/broadcasts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json())
      }

      if (!result.success) throw new Error(result.error)

      if (!broadcastId && result.broadcast?.id) {
        setBroadcastId(result.broadcast.id)
        window.history.replaceState(null, '', `/whatsapp/broadcasts/${result.broadcast.id}`)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSend() {
    if (!broadcastId) await handleSave()
    if (!templateId) {
      setError('Select an approved template first')
      return
    }
    if (!confirm('Send this broadcast? This cannot be undone.')) return

    setSending(true)
    setError(null)

    try {
      await handleSave()

      const result = await fetch(`/api/whatsapp/broadcasts/${broadcastId}/send`, {
        method: 'POST',
      }).then(r => r.json())

      if (!result.success) throw new Error(result.error)

      router.push(`/whatsapp/broadcasts/${broadcastId}`)
      router.refresh()
    } catch (err) {
      setError(err.message)
      setSending(false)
    }
  }

  async function handlePauseToggle() {
    setPausing(true)
    setError(null)
    try {
      const paused = !broadcast.paused_at
      const res = await fetch(`/api/whatsapp/broadcasts/${broadcastId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      }).then(r => r.json())
      if (!res.success) throw new Error(res.error)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setPausing(false)
    }
  }

  // WA-SCHEDULE — cancel-before-send: back to a plain draft (the SMS
  // un-schedule idiom). The cron only promotes status='scheduled' rows, so
  // this reliably stops the send.
  async function handleUnschedule() {
    if (!confirm('Cancel the scheduled send? The broadcast returns to draft — nothing will go out until you send or re-schedule it.')) return
    setCancelling(true)
    setError(null)
    try {
      // scheduled_at cleared too (not just the status): the cron's blast
      // resume arm keys on scheduled_at IS NOT NULL, so a stale timestamp
      // would put a later operator-fired send of this row under cron care.
      const res = await fetch(`/api/whatsapp/broadcasts/${broadcastId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'draft', scheduled_at: null }),
      }).then(r => r.json())
      if (!res.success) throw new Error(res.error)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setCancelling(false)
    }
  }

  async function handleCancel() {
    if (!confirm('Cancel this campaign? Messages already sent stay sent, but no more will go out — this cannot be undone.')) return
    setCancelling(true)
    setError(null)
    try {
      const res = await fetch(`/api/whatsapp/broadcasts/${broadcastId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      }).then(r => r.json())
      if (!res.success) throw new Error(res.error)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setCancelling(false)
    }
  }

  async function handleSaveDripSettings() {
    setSavingDrip(true)
    setError(null)
    try {
      const cap = Number(capInput)
      const tick = Number(tickInput)
      const payload = {}
      if (cap > 0) payload.daily_cap = cap
      if (tick > 0) payload.per_tick_max = tick
      const res = await fetch(`/api/whatsapp/broadcasts/${broadcastId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.json())
      if (!res.success) throw new Error(res.error)
      setEditingDrip(false)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingDrip(false)
    }
  }

  const recipients = broadcast?.whatsapp_broadcast_recipients || []

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-border bg-un1t-surface shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/whatsapp/broadcasts" className="text-un1t-subtle hover:text-un1t-text transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Broadcast name..."
            disabled={isTerminal}
            className="bg-transparent text-lg font-semibold text-un1t-text placeholder:text-un1t-muted focus:outline-none w-64 disabled:opacity-70"
          />
          {broadcast?.status && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              broadcast.status === 'sent' ? 'bg-green-500/20 text-green-700'
                : broadcast.status === 'cancelled' ? 'bg-rose-500/20 text-rose-700'
                : broadcast.status === 'scheduled' ? 'bg-blue-500/15 text-blue-700'
                : 'bg-gray-500/20 text-gray-700'
            }`}>
              {broadcast.status}
            </span>
          )}
        </div>

        {!isTerminal && !isDripInFlight && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save'}
            </button>
            {/* A scheduled broadcast is fired by the cron, not this button —
                offer cancel-schedule instead (sendBroadcast would refuse the
                'scheduled' entry state anyway). */}
            {isScheduled ? (
              <button
                type="button"
                onClick={handleUnschedule}
                disabled={cancelling}
                className="flex items-center gap-1.5 text-sm border border-rose-500/30 text-rose-700 font-medium px-4 py-1.5 rounded-md hover:bg-rose-500/10 transition-colors disabled:opacity-50"
              >
                <Ban size={14} />
                {cancelling ? 'Cancelling…' : 'Cancel schedule'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={sending || !templateId}
                className="flex items-center gap-1.5 text-sm bg-green-600 text-white font-medium px-4 py-1.5 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                <Send size={14} />
                {sending ? 'Sending...' : 'Send Broadcast'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* GAPS-P4 — quiet-hours advisory for "Send Broadcast", which fires
          immediately. This page has NO schedule picker (WhatsApp scheduling is
          created from /communications/send), so there is nothing to set and
          the notice states the next acceptable slot instead of offering a
          button. A drip is exempt: it paces itself inside its own daily
          window, so pressing send does not put a message on a phone now. */}
      {!isTerminal && !isScheduled && !isDripInFlight && broadcast?.delivery_mode !== 'drip' && (
        <div className="px-5 pt-3">
          <SendQuietHoursNotice locationId={locationId} />
        </div>
      )}

      {/* WA-SCHEDULE — scheduled banner: when it goes out + how to stop it. */}
      {isScheduled && (
        <div className="bg-blue-500/10 border-b border-blue-500/30 text-blue-700 text-sm px-5 py-2 flex items-center gap-2">
          <Clock size={14} className="shrink-0" />
          <span>
            Scheduled — goes out {broadcast?.scheduled_at
              ? new Date(broadcast.scheduled_at).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
              : 'soon'}
            {broadcast?.delivery_mode === 'drip' ? ' (drip starts then and paces itself inside its daily window)' : ''}.
            {' '}Use “Cancel schedule” to stop it before then.
          </span>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-700 text-sm px-5 py-2">
          {error}
        </div>
      )}

      {/* Tabs for sent broadcasts */}
      {isTerminal && (
        <div className="flex border-b border-un1t-border bg-un1t-surface shrink-0">
          {[
            { key: 'results', label: 'Results' },
            { key: 'recipients', label: `Recipients (${broadcast.total_sent || 0})` },
          ].map(t => (
            <button
              type="button"
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key ? 'text-un1t-text border-un1t-text' : 'text-un1t-subtle border-transparent hover:text-un1t-text'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {isTerminal && tab === 'results' && (
          <div className="max-w-3xl space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <p className="text-xs text-un1t-subtle uppercase">Sent</p>
                <p className="text-2xl font-bold mt-1">{(dripProgress?.dispatched ?? broadcast.total_sent ?? 0).toLocaleString()}</p>
              </div>
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <p className="text-xs text-un1t-subtle uppercase">Delivered</p>
                <p className="text-2xl font-bold mt-1 text-green-400">{broadcast.total_delivered || 0}</p>
              </div>
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <p className="text-xs text-un1t-subtle uppercase">Read</p>
                <p className="text-2xl font-bold mt-1 text-blue-400">{broadcast.total_read || 0}</p>
              </div>
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <p className="text-xs text-un1t-subtle uppercase">Failed</p>
                <p className="text-2xl font-bold mt-1 text-red-400">{broadcast.total_failed || 0}</p>
              </div>
            </div>
            {broadcast.delivery_summary && (broadcast.delivery_summary.matched - broadcast.delivery_summary.reachable) > 0 && (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <p className="text-xs text-un1t-subtle uppercase">Excluded from this send</p>
                <p className="text-sm mt-1">
                  {(broadcast.delivery_summary.matched - broadcast.delivery_summary.reachable).toLocaleString()} of {broadcast.delivery_summary.matched.toLocaleString()} matched contacts weren&apos;t reachable on WhatsApp.
                </p>
                <ul className="mt-2 text-sm text-un1t-subtle space-y-0.5">
                  {broadcast.delivery_summary.excluded?.no_number ? <li>• {broadcast.delivery_summary.excluded.no_number} have no WhatsApp number</li> : null}
                  {broadcast.delivery_summary.excluded?.no_consent ? <li>• {broadcast.delivery_summary.excluded.no_consent} haven&apos;t opted into WhatsApp marketing</li> : null}
                  {broadcast.delivery_summary.excluded?.opted_out ? <li>• {broadcast.delivery_summary.excluded.opted_out} opted out</li> : null}
                  {broadcast.delivery_summary.excluded?.undeliverable ? <li>• {broadcast.delivery_summary.excluded.undeliverable} not on WhatsApp (undeliverable)</li> : null}
                </ul>
              </div>
            )}
            <FailedSendsBox failedRecipients={failedRecipients} failedCount={failedCount} />
          </div>
        )}

        {isTerminal && tab === 'recipients' && (
          <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-un1t-border text-left text-xs text-un1t-subtle uppercase tracking-wider">
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Sent</th>
                  <th className="px-4 py-3">Delivered</th>
                  <th className="px-4 py-3">Read</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-un1t-border">
                {recipients.map(r => (
                  <tr key={r.id} className="hover:bg-un1t-border/20">
                    <td className="px-4 py-3">
                      <p className="font-medium">{r.contacts?.name || 'Unknown'}</p>
                      <p className="text-xs text-un1t-muted">{r.contacts?.wa_phone || r.contacts?.phone}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`flex items-center gap-1 text-xs ${
                        r.status === 'read' ? 'text-blue-400' :
                        r.status === 'delivered' ? 'text-green-400' :
                        r.status === 'failed' ? 'text-red-400' :
                        'text-un1t-subtle'
                      }`}>
                        {r.status === 'failed' ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
                        {r.status}
                      </span>
                      {/* The send loop stores Meta's per-recipient error —
                          without rendering it, a failure is undebuggable
                          from the UI (bit on the first video-header
                          broadcast: #132012 looked like a mystery). */}
                      {r.status === 'failed' && r.error_message && (
                        <p className="text-[11px] text-red-700 mt-1 max-w-[360px]">{r.error_message}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-un1t-subtle">
                      {r.sent_at ? new Date(r.sent_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-un1t-subtle">
                      {r.delivered_at ? new Date(r.delivered_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-un1t-subtle">
                      {r.read_at ? new Date(r.read_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {isDripInFlight && (
          <div className="max-w-2xl space-y-4">
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider shrink-0">Drip in progress</h3>
                  {dripProgress?.window && (() => {
                    const w = dripProgress.window
                    const cls = w.state === 'sending' ? 'bg-green-500/15 text-green-700'
                      : w.state === 'paused' ? 'bg-amber-500/15 text-amber-700'
                      : 'bg-un1t-border/50 text-un1t-subtle'
                    const label = w.state === 'sending' ? 'Sending'
                      : w.state === 'paused' ? 'Paused'
                      : `Window closed — resumes ${w.resumesAt}`
                    return <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full truncate ${cls}`}>{label}</span>
                  })()}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handlePauseToggle}
                    disabled={pausing || cancelling}
                    className="text-sm border border-un1t-border px-3 py-1.5 rounded-md hover:border-un1t-text/30 transition-colors disabled:opacity-50"
                  >
                    {pausing ? '…' : broadcast.paused_at ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={pausing || cancelling}
                    className="text-sm border border-rose-500/30 text-rose-700 px-3 py-1.5 rounded-md hover:bg-rose-500/10 transition-colors disabled:opacity-50"
                  >
                    {cancelling ? '…' : 'Cancel'}
                  </button>
                </div>
              </div>
              {(() => {
                const dp = dripProgress
                const sent = dp ? dp.dispatched : (broadcast.total_sent || 0)
                const reached = dp ? dp.reached : (broadcast.total_delivered || 0)
                const read = dp ? dp.read : (broadcast.total_read || 0)
                const failed = dp ? dp.failed : (broadcast.total_failed || 0)
                const total = broadcast.total_recipients || 0
                const done = sent + failed
                const remaining = Math.max(0, total - done)
                const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
                const cap = broadcast.daily_cap || 500
                const days = estimateDripDays(remaining, cap)
                return (
                  <>
                    <div className="h-2 bg-un1t-border/40 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <DripStat label="Sent" value={sent.toLocaleString()} />
                      <DripStat label="Delivered" value={reached.toLocaleString()} />
                      <DripStat label="Read" value={read.toLocaleString()} />
                      <DripStat label="Failed" value={failed.toLocaleString()} />
                      <DripStat label="Remaining" value={remaining.toLocaleString()} />
                      <DripStat label="Est. days left" value={remaining === 0 ? '0' : `~${days}`} />
                    </div>
                    <p className="text-xs text-un1t-muted">
                      {dp ? `${dp.sentToday.toLocaleString()} of ${cap.toLocaleString()} sent today · ` : `Up to ${cap.toLocaleString()}/day · `}
                      {String(broadcast.send_window_start).slice(0, 5)}–{String(broadcast.send_window_end).slice(0, 5)} {broadcast.send_window_tz}
                    </p>
                    <div className="pt-1">
                      {!editingDrip ? (
                        <button type="button"
                          onClick={() => { setCapInput(broadcast.daily_cap || 500); setTickInput(broadcast.per_tick_max || ''); setEditingDrip(true) }}
                          className="text-[11px] text-un1t-subtle hover:text-un1t-text underline">Adjust pacing</button>
                      ) : (
                        <div className="rounded-lg border border-un1t-border bg-un1t-bg/40 p-3 space-y-2 text-left">
                          <div className="flex gap-3">
                            <label className="block flex-1">
                              <span className="block text-[11px] font-medium text-un1t-subtle mb-1">Daily limit (/24h)</span>
                              <input type="number" min={1} max={100000} value={capInput} onChange={e => setCapInput(e.target.value)}
                                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm" />
                            </label>
                            <label className="block flex-1">
                              <span className="block text-[11px] font-medium text-un1t-subtle mb-1">Batch / run <span className="text-un1t-subtle/60">(blank = 100)</span></span>
                              <input type="number" min={1} max={5000} value={tickInput} onChange={e => setTickInput(e.target.value)} placeholder="100"
                                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-sm" />
                            </label>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={handleSaveDripSettings} disabled={savingDrip}
                              className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50">
                              {savingDrip ? 'Saving…' : 'Save'}</button>
                            <button type="button" onClick={() => setEditingDrip(false)} disabled={savingDrip}
                              className="text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1.5">Cancel</button>
                            <span className="text-[11px] text-un1t-subtle">Applies on the next 15-min run.</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )
              })()}
            </div>
            <FailedSendsBox failedRecipients={failedRecipients} failedCount={failedCount} />
          </div>
        )}

        {!isTerminal && !isDripInFlight && (
          <div className="max-w-3xl space-y-6">
            {/* Template selection */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Template</h3>

              {templates.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-sm text-un1t-subtle mb-2">No approved templates available</p>
                  <Link href="/whatsapp/templates/new" className="text-sm text-blue-400 hover:underline">
                    Create a template first
                  </Link>
                </div>
              ) : (
                <select
                  value={templateId}
                  onChange={e => setTemplateId(e.target.value)}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                >
                  <option value="">Select a template...</option>
                  {/* WA-TPL-GROUPS — optgroups by operator-set display_group
                      (mig 450); a lone Ungrouped bucket renders flat. */}
                  {groupWaTemplates(templates).map((group, _, groups) => {
                    const options = group.templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name} ({t.category})</option>
                    ))
                    if (groups.length === 1 && group.label === UNGROUPED_LABEL) return options
                    return <optgroup key={group.label} label={group.label}>{options}</optgroup>
                  })}
                </select>
              )}

              {/* Template preview */}
              {selectedTemplate && (
                <div className="bg-[#e5ddd5] rounded-lg p-4">
                  <div className="bg-white rounded-lg p-3 shadow-sm max-w-[260px]">
                    {headerComp?.format === 'TEXT' && (
                      <p className="text-sm font-bold text-gray-900 mb-1">{headerComp.text}</p>
                    )}
                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{bodyComp?.text || ''}</p>
                  </div>
                </div>
              )}

              {/* Variable mapping */}
              {bodyVars.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-un1t-subtle">Map template variables to contact fields:</p>
                  {bodyVars.map((v, i) => {
                    const varNum = v.replace(/[{}]/g, '')
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs text-un1t-muted w-12">{v}</span>
                        <select
                          value={variableMapping[varNum] || ''}
                          onChange={e => setVariableMapping({ ...variableMapping, [varNum]: e.target.value })}
                          className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                        >
                          <option value="">Select field...</option>
                          {VARIABLE_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Header media URL */}
              {headerComp && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerComp.format) && (
                <div>
                  <label className="block text-xs text-un1t-subtle mb-1">Header media URL</label>
                  <input
                    type="url"
                    value={headerMediaUrl}
                    onChange={e => setHeaderMediaUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                  />
                </div>
              )}
            </div>

            {/* Audience */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider mb-4">
                <Users size={14} className="inline mr-1.5" />
                Audience
              </h3>
              <p className="text-xs text-un1t-muted mb-4">
                Only contacts with a WhatsApp number who have opted in to WhatsApp marketing will receive this broadcast.
              </p>
              {/* FILTER-B.3 (FILTER-FOUND row 1) — the legacy Stage = member
                  starting guess is GONE here. P1 kept it only because this
                  surface was blind: an unset row would have widened a
                  broadcast with nothing on screen to say so. The count below
                  now shows the audience live AND names any unfinished row,
                  so the widening failure is stated out loud — while the
                  narrowing the default caused was silent and, on a
                  broadcast to leads and trials, usually wrong. */}
              <AudienceBuilder
                filter={audienceFilter}
                onChange={setAudienceFilter}
                locationId={locationId}
              />
              <AudienceCount
                className="mt-3"
                locationId={locationId}
                filter={audienceFilter}
                channel="whatsapp"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DripStat({ label, value }) {
  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-lg p-3">
      <p className="text-xs text-un1t-subtle uppercase">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
    </div>
  )
}

// Failed-sends summary — name · number · reason. Fed by a dedicated failed-only
// query in the page (the recipients embed is capped at 1000 rows for big drips).
function FailedSendsBox({ failedRecipients = [], failedCount = 0 }) {
  if (!failedCount) return null
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-un1t-border flex items-center gap-2">
        <XCircle size={14} className="text-red-400" />
        <p className="text-sm font-medium text-un1t-text">Failed sends ({failedCount.toLocaleString()})</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
          <thead>
            <tr className="border-b border-un1t-border text-left text-xs text-un1t-subtle uppercase tracking-wider">
              <th className="px-4 py-2">Contact</th>
              <th className="px-4 py-2">Number</th>
              <th className="px-4 py-2">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-border">
            {failedRecipients.map(r => (
              <tr key={r.id} className="hover:bg-un1t-border/20">
                <td className="px-4 py-2">{r.contacts?.name || 'Unknown'}</td>
                <td className="px-4 py-2 text-un1t-subtle tabular-nums">{r.contacts?.wa_phone || r.contacts?.phone || '—'}</td>
                <td className="px-4 py-2 text-red-700">{r.error_message || 'Delivery failed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failedCount > failedRecipients.length && (
        <p className="px-4 py-2 text-[11px] text-un1t-subtle border-t border-un1t-border">
          Showing the {failedRecipients.length.toLocaleString()} most recent of {failedCount.toLocaleString()} failures.
        </p>
      )}
    </div>
  )
}
