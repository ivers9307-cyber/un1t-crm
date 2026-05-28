'use client'

// CONSENT.3 — Consent history table at the bottom of the contact
// profile. Append-only audit feed of every opt-in / opt-out event
// for the contact, sourced from the consent_log table (mig 005).
//
// Default collapsed because it's not needed daily. When expanded,
// lazy-loads the rows so the contact page's initial render isn't
// paying for it. Once loaded, stays in memory for the session.

import { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, Loader2, AlertCircle, ArrowDown, ArrowUp } from 'lucide-react'

const SOURCE_LABELS = {
  preference_centre:        { label: 'Customer self-service',     tone: 'blue' },
  admin_panel:              { label: 'Admin panel',               tone: 'amber' },
  auto_classpass:           { label: 'Auto (ClassPass)',          tone: 'purple' },
  auto_classpass_backfill:  { label: 'Auto (ClassPass backfill)', tone: 'purple' },
  unsubscribe_one_click:    { label: 'One-click unsubscribe',     tone: 'blue' },
  // CONSENT.4 — public-form soft opt-in / explicit opt-out captured
  // alongside a booking or event registration submission.
  booking_form:             { label: 'Booking form',              tone: 'emerald' },
  event_form:               { label: 'Event registration form',   tone: 'emerald' },
  // CONSENT.5 — operator-driven CSV import migrating consent from
  // an external platform (Mailchimp / Klaviyo / etc).
  bulk_import:              { label: 'Bulk import',               tone: 'amber' },
}

const CHANNEL_LABELS = {
  email_marketing:         'Email · marketing',
  email_administrative:    'Email · transactional',
  sms_marketing:           'SMS · marketing',
  sms_administrative:      'SMS · transactional',
  whatsapp_marketing:      'WhatsApp · marketing',
  whatsapp_administrative: 'WhatsApp · transactional',
}

const TONE_CLASS = {
  blue:    'bg-blue-500/10 text-blue-700 border-blue-500/30',
  amber:   'bg-amber-500/10 text-amber-700 border-amber-500/30',
  purple:  'bg-purple-500/10 text-purple-700 border-purple-500/30',
  emerald: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  gray:    'bg-un1t-border/30 text-un1t-subtle border-un1t-border',
}

function fmtSource(s) {
  return SOURCE_LABELS[s] || { label: s || 'unknown', tone: 'gray' }
}
function fmtChannel(c) { return CHANNEL_LABELS[c] || c }
function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-IE', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function ContactConsentHistoryCard({ contactId }) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (loaded || loading) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/consent-log`)
      const j = await r.json()
      if (!r.ok || !j.success) {
        setError(j.error || `HTTP ${r.status}`)
      } else {
        setRows(j.rows || [])
        setTruncated(!!j.truncated)
        setLoaded(true)
      }
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }, [contactId, loaded, loading])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) load()
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-un1t-border/10"
      >
        <div className="flex items-center gap-2">
          {open
            ? <ChevronDown size={14} className="text-un1t-subtle" />
            : <ChevronRight size={14} className="text-un1t-subtle" />}
          <ShieldCheck size={14} className="text-un1t-subtle" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
            Consent history
          </h3>
          {loaded && (
            <span className="ml-1 text-[11px] text-un1t-muted tabular-nums">
              {rows.length}{truncated ? '+' : ''} event{rows.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <span className="text-[11px] text-un1t-muted">
          {open ? 'hide' : 'show'}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-un1t-border">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-un1t-muted py-3">
              <Loader2 size={12} className="animate-spin" /> loading…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded p-2 my-3">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!loading && loaded && rows.length === 0 && (
            <p className="text-xs text-un1t-muted italic py-3">
              No consent events on file.
            </p>
          )}

          {!loading && loaded && rows.length > 0 && (
            <>
              <div className="overflow-x-auto pt-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-un1t-muted border-b border-un1t-border">
                      <th className="py-1.5 pr-3 font-medium">When</th>
                      <th className="py-1.5 pr-3 font-medium">Action</th>
                      <th className="py-1.5 pr-3 font-medium">Channel</th>
                      <th className="py-1.5 pr-3 font-medium">Source</th>
                      <th className="py-1.5 pr-3 font-medium">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const { label: srcLabel, tone } = fmtSource(r.source)
                      const tonecls = TONE_CLASS[tone] || TONE_CLASS.gray
                      const ActionIcon = r.action === 'opt_in' ? ArrowUp : ArrowDown
                      const actionCls = r.action === 'opt_in' ? 'text-emerald-600' : 'text-rose-600'
                      return (
                        <tr key={r.id} className="border-b border-un1t-border/40 last:border-0">
                          <td className="py-1.5 pr-3 text-un1t-subtle tabular-nums whitespace-nowrap">
                            {fmtDate(r.created_at)}
                          </td>
                          <td className="py-1.5 pr-3">
                            <span className={`inline-flex items-center gap-1 ${actionCls} font-medium`}>
                              <ActionIcon size={11} />
                              {r.action === 'opt_in' ? 'Opt-in' : 'Opt-out'}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-un1t-text">{fmtChannel(r.channel)}</td>
                          <td className="py-1.5 pr-3">
                            <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${tonecls}`}>
                              {srcLabel}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-un1t-subtle">
                            {r.performed_by_name || (
                              <span className="text-un1t-muted italic">
                                {r.source === 'preference_centre' || r.source === 'unsubscribe_one_click'
                                  ? 'customer'
                                  : 'system'}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {truncated && (
                <p className="text-[11px] text-amber-700 mt-2">
                  Showing the most recent 500 events. Older entries exist in the
                  database — query <code>consent_log</code> directly if you need them.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
