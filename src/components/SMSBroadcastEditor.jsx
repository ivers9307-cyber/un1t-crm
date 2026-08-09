'use client'

// SMS broadcast editor — handles the full lifecycle: new draft,
// edit existing draft, view results of a sent broadcast. Mirrors
// WABroadcastEditor but for freeform SMS bodies (no Meta template
// approval, just plain text + merge tags).
//
// Tabs:
//   - Setup   : name, body (with segment counter + merge-tag chips),
//               audience (AudienceBuilder reused). Shown for draft.
//   - Results : per-recipient status + error breakdown. Shown for
//               sent / sending / cancelled.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Save, Send, Users, MessageSquare,
  CheckCircle2, XCircle, Trash2, Ban, Calendar, Clock,
} from 'lucide-react'
import AudienceBuilder, { STAGE_MEMBER_DEFAULT_ROW } from './AudienceBuilder'

// SMS segment math — single GSM7 fits 160 chars; multi-segment
// concatenation is 153 per segment (7 lost to UDH per segment).
function segmentInfo(text) {
  const len = text.length
  if (len === 0) return { len: 0, segments: 0 }
  if (len <= 160) return { len, segments: 1 }
  return { len, segments: Math.ceil(len / 153) }
}

const MERGE_TAGS = [
  { tag: '{{first_name}}', label: 'First name' },
  { tag: '{{name}}', label: 'Full name' },
  { tag: '{{location_name}}', label: 'Location' },
]

// Convert ISO 8601 to the format datetime-local expects (yyyy-MM-ddTHH:mm).
// Hardcoded to LOCAL time — datetime-local has no tz, so what the
// user picks is interpreted in their browser's tz, then we serialise
// back to ISO with the local offset before sending.
function isoToLocalDatetime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localDatetimeToIso(local) {
  if (!local) return null
  // new Date() interprets local-form strings in the browser's tz.
  return new Date(local).toISOString()
}

export default function SMSBroadcastEditor({ broadcast, recipients = [], locationId, locationSenderId, userId: _userId, initialAudienceFilter = null }) {
  const router = useRouter()
  const isSent = broadcast?.status === 'sent'
  const isSending = broadcast?.status === 'sending'
  const isScheduled = broadcast?.status === 'scheduled'
  const isCancelled = broadcast?.status === 'cancelled'
  // 'scheduled' is editable (un-schedule first via the same UI), so
  // the lock applies only to terminal/in-flight states.
  const isLocked = isSent || isSending || isCancelled

  const [name, setName] = useState(broadcast?.name || '')
  const [body, setBody] = useState(broadcast?.body || '')
  const [audienceFilter, setAudienceFilter] = useState(
    // Precedence: existing draft > deep-link preset (e.g. ?segment=race_completed
    // from /communications/segments) > empty.
    broadcast?.audience_filter || initialAudienceFilter || { filters: [], logic: 'and' }
  )
  const [scheduledAtLocal, setScheduledAtLocal] = useState(
    isoToLocalDatetime(broadcast?.scheduled_at)
  )
  const [broadcastId, setBroadcastId] = useState(broadcast?.id || null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState(isLocked ? 'results' : 'setup')

  const seg = segmentInfo(body)

  function insertMergeTag(tag) {
    setBody(prev => prev + (prev.endsWith(' ') || prev.length === 0 ? '' : ' ') + tag)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const scheduledIso = localDatetimeToIso(scheduledAtLocal)
      const payload = {
        name: name || 'Untitled SMS Broadcast',
        body,
        audience_filter: audienceFilter,
        scheduled_at: scheduledIso,
        location_id: locationId,
      }

      let res
      if (broadcastId) {
        res = await fetch(`/api/sms/broadcasts/${broadcastId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: payload.name,
            body: payload.body,
            audience_filter: payload.audience_filter,
            scheduled_at: scheduledIso,
          }),
        })
      } else {
        res = await fetch('/api/sms/broadcasts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Save failed')

      if (!broadcastId && data.broadcast?.id) {
        setBroadcastId(data.broadcast.id)
        window.history.replaceState(null, '', `/communications/sms/broadcasts/${data.broadcast.id}`)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSchedule() {
    if (!broadcastId) {
      setError('Save the draft first before scheduling.')
      return
    }
    if (!scheduledAtLocal) {
      setError('Pick a date and time before scheduling.')
      return
    }
    const iso = localDatetimeToIso(scheduledAtLocal)
    if (new Date(iso).getTime() <= Date.now()) {
      setError('Scheduled time must be in the future.')
      return
    }
    setScheduling(true)
    setError(null)
    try {
      const res = await fetch(`/api/sms/broadcasts/${broadcastId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'scheduled', scheduled_at: iso }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Schedule failed')
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setScheduling(false)
    }
  }

  async function handleUnschedule() {
    if (!broadcastId) return
    if (!confirm('Un-schedule this broadcast? It will return to draft state.')) return
    try {
      const res = await fetch(`/api/sms/broadcasts/${broadcastId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'draft' }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Un-schedule failed')
      router.refresh()
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleSend() {
    if (!broadcastId) {
      setError('Save the draft first before sending.')
      return
    }
    if (!confirm(`Send this SMS to all matching contacts? This cannot be undone.`)) return

    setSending(true)
    setError(null)
    try {
      const res = await fetch(`/api/sms/broadcasts/${broadcastId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Send failed')
      router.refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  async function handleCancel() {
    if (!broadcastId) {
      router.push('/communications/sms/broadcasts')
      return
    }
    if (!confirm('Cancel this draft? It will be marked cancelled and no longer editable.')) return
    try {
      const res = await fetch(`/api/sms/broadcasts/${broadcastId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Cancel failed')
      router.refresh()
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleDelete() {
    if (!broadcastId) return
    if (!confirm('Delete this draft permanently?')) return
    try {
      const res = await fetch(`/api/sms/broadcasts/${broadcastId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Delete failed')
      router.push('/communications/sms/broadcasts')
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div>
      <Link
        href="/communications/sms/broadcasts"
        className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4"
      >
        <ArrowLeft size={16} /> Back to SMS broadcasts
      </Link>

      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <MessageSquare size={20} className="text-cyan-400" />
            {broadcastId ? (name || 'Untitled') : 'New SMS Broadcast'}
          </h2>
          <p className="text-xs text-un1t-subtle mt-0.5">
            Sender ID: <code className="text-un1t-text">{locationSenderId || 'not set — falling back to env'}</code>
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-un1t-border">
        <button
          type="button"
          onClick={() => setTab('setup')}
          className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === 'setup' ? 'border-un1t-text text-un1t-text' : 'border-transparent text-un1t-subtle hover:text-un1t-text'}`}
        >
          Setup
        </button>
        {(isLocked || isSending) && (
          <button
            type="button"
            onClick={() => setTab('results')}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === 'results' ? 'border-un1t-text text-un1t-text' : 'border-transparent text-un1t-subtle hover:text-un1t-text'}`}
          >
            Results
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {tab === 'setup' && (
        <div className="space-y-4">
          <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 space-y-3">
            <div>
              <label className="block text-sm mb-1.5">Internal name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={isLocked}
                placeholder="e.g. October trial reminder"
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted disabled:opacity-60"
              />
              <p className="text-[11px] text-un1t-muted mt-1">Used by your team only — recipients don't see this.</p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm">Message body</label>
                <span className={`text-[11px] ${seg.segments > 1 ? 'text-amber-500' : 'text-un1t-subtle'}`}>
                  {seg.len} chars · {seg.segments} segment{seg.segments === 1 ? '' : 's'}
                </span>
              </div>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                disabled={isLocked}
                rows={6}
                maxLength={1600}
                placeholder="Hi {{first_name}}, your trial expires in 2 days. Book your renewal at https://..."
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted resize-y disabled:opacity-60"
              />
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <span className="text-[11px] text-un1t-muted">Insert:</span>
                {MERGE_TAGS.map(t => (
                  <button
                    key={t.tag}
                    type="button"
                    disabled={isLocked}
                    onClick={() => insertMergeTag(t.tag)}
                    className="text-[11px] px-2 py-0.5 bg-un1t-border/40 hover:bg-un1t-border/70 rounded transition-colors disabled:opacity-50"
                  >
                    {t.label} <code className="text-un1t-muted">{t.tag}</code>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Users size={16} className="text-un1t-subtle" />
              <h3 className="text-sm font-semibold">Audience</h3>
            </div>
            <p className="text-xs text-un1t-subtle mb-3">
              Filters apply on top of "active sms_status + has phone + at this location" — opted-out and missing-phone contacts are always excluded.
            </p>
            {/* COMMSFIX.B.4 — the prop is `filter`, not `value`; the old
                value= made every saved/deep-linked audience invisible and one
                'Add filter' click silently replaced it with the default row. */}
            <AudienceBuilder
              filter={audienceFilter}
              onChange={setAudienceFilter}
              audienceCount={null}
              disabled={isLocked || isScheduled}
              defaultFilterRow={STAGE_MEMBER_DEFAULT_ROW}
            />
          </div>

          {/* Schedule (mig 061). Setting a future time + clicking
              "Schedule" parks the broadcast in 'scheduled' state for
              the cron to pick up. Leave blank to send immediately
              via the "Send now" button below. */}
          <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Calendar size={16} className="text-un1t-subtle" />
              <h3 className="text-sm font-semibold">Schedule (optional)</h3>
              {isScheduled && (
                <span className="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 ml-auto flex items-center gap-1">
                  <Clock size={10} /> Queued for{' '}
                  {broadcast?.scheduled_at
                    ? new Date(broadcast.scheduled_at).toLocaleString()
                    : '?'}
                </span>
              )}
            </div>
            <p className="text-xs text-un1t-subtle mb-3">
              Pick a future date + time, then click <span className="text-un1t-text">Schedule send</span>. The cron picks up scheduled broadcasts every 5 minutes. Leave blank to send immediately.
            </p>
            <input
              type="datetime-local"
              value={scheduledAtLocal}
              onChange={e => setScheduledAtLocal(e.target.value)}
              disabled={isLocked}
              min={isoToLocalDatetime(new Date().toISOString())}
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-60"
            />
          </div>

          {/* Action bar */}
          {!isLocked && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex gap-2 flex-wrap">
                {!isScheduled && (
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !body.trim()}
                    className="flex items-center gap-1.5 text-sm bg-un1t-border text-un1t-text px-4 py-2 rounded-md hover:bg-un1t-border/70 disabled:opacity-50"
                  >
                    <Save size={14} /> {saving ? 'Saving…' : 'Save draft'}
                  </button>
                )}
                {isScheduled && (
                  <button
                    type="button"
                    onClick={handleUnschedule}
                    className="flex items-center gap-1.5 text-sm bg-un1t-border text-un1t-text px-4 py-2 rounded-md hover:bg-un1t-border/70"
                  >
                    <Ban size={14} /> Un-schedule
                  </button>
                )}
                {broadcastId && !isScheduled && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="flex items-center gap-1.5 text-sm bg-un1t-border/40 text-un1t-subtle px-3 py-2 rounded-md hover:text-un1t-text"
                  >
                    <Ban size={14} /> Cancel draft
                  </button>
                )}
                {broadcastId && !isScheduled && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="flex items-center gap-1.5 text-sm text-red-700 px-3 py-2 rounded-md hover:bg-red-500/10"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                {!isScheduled && scheduledAtLocal && broadcastId && (
                  <button
                    type="button"
                    onClick={handleSchedule}
                    disabled={scheduling || !body.trim()}
                    className="flex items-center gap-1.5 text-sm bg-un1t-border text-un1t-text px-4 py-2 rounded-md hover:bg-un1t-border/70 disabled:opacity-50"
                  >
                    <Calendar size={14} /> {scheduling ? 'Scheduling…' : 'Schedule send'}
                  </button>
                )}
                {!isScheduled && (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || !broadcastId || !body.trim()}
                    className="flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-50"
                    title={!broadcastId ? 'Save the draft first' : ''}
                  >
                    <Send size={14} /> {sending ? 'Sending…' : 'Send now'}
                  </button>
                )}
              </div>
            </div>
          )}
          {isLocked && (
            <p className="text-xs text-un1t-muted pt-2">
              This broadcast is in <code className="text-un1t-subtle">{broadcast?.status}</code> state and is read-only.
              {isSent && ' See the Results tab for delivery breakdown.'}
            </p>
          )}
        </div>
      )}

      {tab === 'results' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
              <div className="text-xs text-un1t-subtle uppercase tracking-wider">Recipients</div>
              <div className="text-2xl font-bold mt-1">{broadcast?.total_recipients ?? 0}</div>
            </div>
            <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
              <div className="text-xs text-un1t-subtle uppercase tracking-wider flex items-center gap-1.5">
                <CheckCircle2 size={12} className="text-green-400" /> Sent
              </div>
              <div className="text-2xl font-bold mt-1 text-green-400">{broadcast?.total_sent ?? 0}</div>
            </div>
            <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
              <div className="text-xs text-un1t-subtle uppercase tracking-wider flex items-center gap-1.5">
                <CheckCircle2 size={12} className="text-emerald-400" /> Delivered
              </div>
              <div className="text-2xl font-bold mt-1 text-emerald-400">{broadcast?.total_delivered ?? 0}</div>
              <div className="text-[10px] text-un1t-muted mt-1">carrier-confirmed</div>
            </div>
            <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
              <div className="text-xs text-un1t-subtle uppercase tracking-wider flex items-center gap-1.5">
                <XCircle size={12} className="text-amber-400" /> Undelivered
              </div>
              <div className="text-2xl font-bold mt-1 text-amber-400">{broadcast?.total_undelivered ?? 0}</div>
              <div className="text-[10px] text-un1t-muted mt-1">carrier rejected</div>
            </div>
            <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
              <div className="text-xs text-un1t-subtle uppercase tracking-wider flex items-center gap-1.5">
                <XCircle size={12} className="text-red-400" /> Failed
              </div>
              <div className="text-2xl font-bold mt-1 text-red-400">{broadcast?.total_failed ?? 0}</div>
            </div>
          </div>

          {/* Caveat — alpha sender IDs in IE/UK have unreliable
              carrier DLRs. Sent count is accurate; delivered count
              under-reports because some carriers never report. */}
          <p className="text-[11px] text-un1t-muted">
            <strong className="text-un1t-subtle">Note on delivered:</strong> some IE/UK carriers don't return delivery receipts for alpha sender IDs. A message in <span className="text-un1t-text">sent</span> state but not <span className="text-un1t-text">delivered</span> has very likely arrived — we just didn't get confirmation back.
          </p>

          {recipients.length > 0 && (
            <div className="bg-un1t-surface border border-un1t-border rounded-2xl divide-y divide-un1t-border">
              <div className="px-5 py-3 text-xs text-un1t-subtle uppercase tracking-wider">Recipients</div>
              {recipients.slice(0, 200).map(r => (
                <div key={r.id} className="px-5 py-2 flex items-center justify-between text-sm">
                  <div className="font-mono text-xs text-un1t-subtle truncate">
                    {r.contact_id.slice(0, 8)}…
                  </div>
                  <div className="flex items-center gap-2">
                    {r.status === 'delivered' ? (
                      <span className="flex items-center gap-1 text-emerald-400 text-xs">
                        <CheckCircle2 size={12} /> Delivered
                      </span>
                    ) : r.status === 'sent' ? (
                      <span className="flex items-center gap-1 text-green-400 text-xs" title="Twilio accepted; awaiting delivery receipt">
                        <CheckCircle2 size={12} /> Sent
                      </span>
                    ) : r.status === 'undelivered' ? (
                      <span className="flex items-center gap-1 text-amber-400 text-xs" title={r.error_message}>
                        <XCircle size={12} /> Undelivered
                      </span>
                    ) : r.status === 'failed' ? (
                      <span className="flex items-center gap-1 text-red-400 text-xs" title={r.error_message}>
                        <XCircle size={12} /> Failed
                      </span>
                    ) : (
                      <span className="text-xs text-un1t-muted">{r.status}</span>
                    )}
                  </div>
                </div>
              ))}
              {recipients.length > 200 && (
                <div className="px-5 py-3 text-xs text-un1t-subtle text-center">
                  Showing first 200 of {recipients.length}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
