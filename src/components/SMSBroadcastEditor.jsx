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
  CheckCircle2, XCircle, Trash2, Ban,
} from 'lucide-react'
import AudienceBuilder from './AudienceBuilder'

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

export default function SMSBroadcastEditor({ broadcast, recipients = [], locationId, locationSenderId, userId: _userId }) {
  const router = useRouter()
  const isSent = broadcast?.status === 'sent'
  const isSending = broadcast?.status === 'sending'
  const isCancelled = broadcast?.status === 'cancelled'
  const isLocked = isSent || isSending || isCancelled

  const [name, setName] = useState(broadcast?.name || '')
  const [body, setBody] = useState(broadcast?.body || '')
  const [audienceFilter, setAudienceFilter] = useState(
    broadcast?.audience_filter || { filters: [], logic: 'and' }
  )
  const [broadcastId, setBroadcastId] = useState(broadcast?.id || null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
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
      const payload = {
        name: name || 'Untitled SMS Broadcast',
        body,
        audience_filter: audienceFilter,
        location_id: locationId,
      }

      let res
      if (broadcastId) {
        res = await fetch(`/api/sms/broadcasts/${broadcastId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: payload.name, body: payload.body, audience_filter: payload.audience_filter }),
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
        className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-4"
      >
        <ArrowLeft size={16} /> Back to SMS broadcasts
      </Link>

      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <MessageSquare size={20} className="text-cyan-400" />
            {broadcastId ? (name || 'Untitled') : 'New SMS Broadcast'}
          </h2>
          <p className="text-xs text-un1t-light mt-0.5">
            Sender ID: <code className="text-un1t-white">{locationSenderId || 'not set — falling back to env'}</code>
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-un1t-gray">
        <button
          onClick={() => setTab('setup')}
          className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === 'setup' ? 'border-un1t-white text-un1t-white' : 'border-transparent text-un1t-light hover:text-un1t-white'}`}
        >
          Setup
        </button>
        {(isLocked || isSending) && (
          <button
            onClick={() => setTab('results')}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === 'results' ? 'border-un1t-white text-un1t-white' : 'border-transparent text-un1t-light hover:text-un1t-white'}`}
          >
            Results
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {tab === 'setup' && (
        <div className="space-y-4">
          <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 space-y-3">
            <div>
              <label className="block text-sm mb-1.5">Internal name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={isLocked}
                placeholder="e.g. October trial reminder"
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid disabled:opacity-60"
              />
              <p className="text-[11px] text-un1t-mid mt-1">Used by your team only — recipients don't see this.</p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm">Message body</label>
                <span className={`text-[11px] ${seg.segments > 1 ? 'text-amber-500' : 'text-un1t-light'}`}>
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
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid resize-y disabled:opacity-60"
              />
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <span className="text-[11px] text-un1t-mid">Insert:</span>
                {MERGE_TAGS.map(t => (
                  <button
                    key={t.tag}
                    type="button"
                    disabled={isLocked}
                    onClick={() => insertMergeTag(t.tag)}
                    className="text-[11px] px-2 py-0.5 bg-un1t-gray/40 hover:bg-un1t-gray/70 rounded transition-colors disabled:opacity-50"
                  >
                    {t.label} <code className="text-un1t-mid">{t.tag}</code>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Users size={16} className="text-un1t-light" />
              <h3 className="text-sm font-semibold">Audience</h3>
            </div>
            <p className="text-xs text-un1t-light mb-3">
              Filters apply on top of "active sms_status + has phone + at this location" — opted-out and missing-phone contacts are always excluded.
            </p>
            <AudienceBuilder
              value={audienceFilter}
              onChange={setAudienceFilter}
              disabled={isLocked}
            />
          </div>

          {/* Action bar */}
          {!isLocked && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving || !body.trim()}
                  className="flex items-center gap-1.5 text-sm bg-un1t-gray text-un1t-white px-4 py-2 rounded-md hover:bg-un1t-gray/70 disabled:opacity-50"
                >
                  <Save size={14} /> {saving ? 'Saving…' : 'Save draft'}
                </button>
                {broadcastId && (
                  <button
                    onClick={handleCancel}
                    className="flex items-center gap-1.5 text-sm bg-un1t-gray/40 text-un1t-light px-3 py-2 rounded-md hover:text-un1t-white"
                  >
                    <Ban size={14} /> Cancel draft
                  </button>
                )}
                {broadcastId && (
                  <button
                    onClick={handleDelete}
                    className="flex items-center gap-1.5 text-sm text-red-400 px-3 py-2 rounded-md hover:bg-red-500/10"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </div>
              <button
                onClick={handleSend}
                disabled={sending || !broadcastId || !body.trim()}
                className="flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-medium px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-50"
                title={!broadcastId ? 'Save the draft first' : ''}
              >
                <Send size={14} /> {sending ? 'Sending…' : 'Send now'}
              </button>
            </div>
          )}
          {isLocked && (
            <p className="text-xs text-un1t-mid pt-2">
              This broadcast is in <code className="text-un1t-light">{broadcast?.status}</code> state and is read-only.
              {isSent && ' See the Results tab for delivery breakdown.'}
            </p>
          )}
        </div>
      )}

      {tab === 'results' && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4">
              <div className="text-xs text-un1t-light uppercase tracking-wider">Recipients</div>
              <div className="text-2xl font-bold mt-1">{broadcast?.total_recipients ?? 0}</div>
            </div>
            <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4">
              <div className="text-xs text-un1t-light uppercase tracking-wider flex items-center gap-1.5">
                <CheckCircle2 size={12} className="text-green-400" /> Sent
              </div>
              <div className="text-2xl font-bold mt-1 text-green-400">{broadcast?.total_sent ?? 0}</div>
            </div>
            <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4">
              <div className="text-xs text-un1t-light uppercase tracking-wider flex items-center gap-1.5">
                <XCircle size={12} className="text-red-400" /> Failed
              </div>
              <div className="text-2xl font-bold mt-1 text-red-400">{broadcast?.total_failed ?? 0}</div>
            </div>
          </div>

          {recipients.length > 0 && (
            <div className="bg-un1t-dark border border-un1t-gray rounded-2xl divide-y divide-un1t-gray">
              <div className="px-5 py-3 text-xs text-un1t-light uppercase tracking-wider">Recipients</div>
              {recipients.slice(0, 200).map(r => (
                <div key={r.id} className="px-5 py-2 flex items-center justify-between text-sm">
                  <div className="font-mono text-xs text-un1t-light truncate">
                    {r.contact_id.slice(0, 8)}…
                  </div>
                  <div className="flex items-center gap-2">
                    {r.status === 'sent' ? (
                      <span className="flex items-center gap-1 text-green-400 text-xs">
                        <CheckCircle2 size={12} /> Sent
                      </span>
                    ) : r.status === 'failed' ? (
                      <span className="flex items-center gap-1 text-red-400 text-xs" title={r.error_message}>
                        <XCircle size={12} /> Failed
                      </span>
                    ) : (
                      <span className="text-xs text-un1t-mid">{r.status}</span>
                    )}
                  </div>
                </div>
              ))}
              {recipients.length > 200 && (
                <div className="px-5 py-3 text-xs text-un1t-light text-center">
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
