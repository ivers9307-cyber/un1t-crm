'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Send, Users, CheckCircle2, XCircle } from 'lucide-react'
import AudienceBuilder from './AudienceBuilder'
import { estimateDripDays } from '@/lib/whatsapp-drip'

export default function WABroadcastEditor({ broadcast, templates, locationId, userId }) {
  const router = useRouter()
  const isSent = broadcast?.status === 'sent'
  const isDripInFlight = broadcast?.delivery_mode === 'drip' && broadcast?.status === 'sending'

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
  const [error, setError] = useState(null)
  const [tab, setTab] = useState(isSent ? 'results' : 'setup')

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
            disabled={isSent}
            className="bg-transparent text-lg font-semibold text-un1t-text placeholder:text-un1t-muted focus:outline-none w-64 disabled:opacity-70"
          />
          {broadcast?.status && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              broadcast.status === 'sent' ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
            }`}>
              {broadcast.status}
            </span>
          )}
        </div>

        {!isSent && !isDripInFlight && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !templateId}
              className="flex items-center gap-1.5 text-sm bg-green-600 text-white font-medium px-4 py-1.5 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              <Send size={14} />
              {sending ? 'Sending...' : 'Send Broadcast'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm px-5 py-2">
          {error}
        </div>
      )}

      {/* Tabs for sent broadcasts */}
      {isSent && (
        <div className="flex border-b border-un1t-border bg-un1t-surface shrink-0">
          {[
            { key: 'results', label: 'Results' },
            { key: 'recipients', label: `Recipients (${broadcast.total_sent || 0})` },
          ].map(t => (
            <button
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
        {isSent && tab === 'results' && (
          <div className="max-w-3xl space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <p className="text-xs text-un1t-subtle uppercase">Sent</p>
                <p className="text-2xl font-bold mt-1">{broadcast.total_sent || 0}</p>
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
          </div>
        )}

        {isSent && tab === 'recipients' && (
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
            {broadcast.paused_at && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 text-sm px-4 py-2">
                Paused — resume to continue sending.
              </div>
            )}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Drip in progress</h3>
                <button
                  onClick={handlePauseToggle}
                  disabled={pausing}
                  className="text-sm border border-un1t-border px-3 py-1.5 rounded-md hover:border-un1t-text/30 transition-colors disabled:opacity-50"
                >
                  {pausing ? '…' : broadcast.paused_at ? 'Resume' : 'Pause'}
                </button>
              </div>
              {(() => {
                const total = broadcast.total_recipients || 0
                const done = (broadcast.total_sent || 0) + (broadcast.total_failed || 0)
                const remaining = Math.max(0, total - done)
                const pct = total > 0 ? Math.round((done / total) * 100) : 0
                const days = estimateDripDays(remaining, broadcast.daily_cap || 500)
                return (
                  <>
                    <div className="h-2 bg-un1t-border/40 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-center">
                      <DripStat label="Sent" value={broadcast.total_sent || 0} />
                      <DripStat label="Failed" value={broadcast.total_failed || 0} />
                      <DripStat label="Remaining" value={remaining} />
                      <DripStat label="Est. days left" value={remaining === 0 ? '0' : `~${days}`} />
                    </div>
                    <p className="text-xs text-un1t-muted">
                      Up to {broadcast.daily_cap || 500}/day · {String(broadcast.send_window_start).slice(0, 5)}–{String(broadcast.send_window_end).slice(0, 5)} {broadcast.send_window_tz}
                    </p>
                  </>
                )
              })()}
            </div>
          </div>
        )}

        {!isSent && !isDripInFlight && (
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
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ({t.category})</option>
                  ))}
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
              <AudienceBuilder
                filter={audienceFilter}
                onChange={setAudienceFilter}
                audienceCount={null}
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
