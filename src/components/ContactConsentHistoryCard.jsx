'use client'

// CONSENT.3 — Consent history table at the bottom of the contact
// profile. Append-only audit feed of every opt-in / opt-out event
// for the contact, sourced from the consent_log table (mig 005).
//
// Default collapsed because it's not needed daily. When expanded,
// lazy-loads the rows so the contact page's initial render isn't
// paying for it. Once loaded, stays in memory for the session.

import { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, Loader2, AlertCircle, ArrowDown, ArrowUp, Download } from 'lucide-react'

// Every `source` string a live consent_log row actually carries, as of the
// GAPS-P6 audit. An unmapped source falls back to the raw slug (fmtSource) —
// readable, but a compliance officer should not have to decode
// `leadcap1_scope_correction` on their own, so the known set is spelled out.
const SOURCE_LABELS = {
  preference_centre:        { label: 'Customer self-service',     tone: 'blue' },
  admin_panel:              { label: 'Admin panel',               tone: 'amber' },
  auto_classpass:           { label: 'Auto (ClassPass)',          tone: 'purple' },
  auto_classpass_backfill:  { label: 'Auto (ClassPass backfill)', tone: 'purple' },
  unsubscribe_one_click:    { label: 'One-click unsubscribe',     tone: 'blue' },
  one_click_unsubscribe:    { label: 'One-click unsubscribe',     tone: 'blue' },
  // CONSENT.4 — public-form soft opt-in / explicit opt-out captured
  // alongside a booking or event registration submission.
  booking_form:             { label: 'Booking form',              tone: 'emerald' },
  event_form:               { label: 'Event registration form',   tone: 'emerald' },
  waitlist_form:            { label: 'Waitlist form',             tone: 'emerald' },
  host_mailing_list:        { label: 'Host mailing list',         tone: 'emerald' },
  // CONSENT.5 — operator-driven CSV import migrating consent from
  // an external platform (Mailchimp / Klaviyo / etc).
  bulk_import:              { label: 'Bulk import',               tone: 'amber' },
  // WhatsApp: an inbound STOP/START keyword, Meta's own in-app marketing
  // preference control, and the Flow booking form's consent tick.
  whatsapp_keyword:         { label: 'WhatsApp STOP/START',       tone: 'blue' },
  meta_user_preferences:    { label: 'Meta in-app preference',    tone: 'blue' },
  whatsapp_flow:            { label: 'WhatsApp Flow',             tone: 'emerald' },
  // Postmark-side signals: the recipient told the ESP, not us.
  postmark_one_click_unsubscribe: { label: 'One-click unsubscribe (Postmark)', tone: 'blue' },
  postmark_hard_bounce:     { label: 'Hard bounce (Postmark)',    tone: 'gray' },
  postmark_spam_complaint:  { label: 'Spam complaint (Postmark)', tone: 'gray' },
  postmark_suppression_backfill: { label: 'Postmark suppression backfill', tone: 'gray' },
  // An administrative correction, not a decision the customer made — mig 488
  // deliberately excludes it when deciding whether someone withdrew consent.
  leadcap1_scope_correction: { label: 'Scope correction (admin)', tone: 'amber' },
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

// Sources where the person themselves acted — the "By" column says
// "customer" rather than "system" for these.
const CUSTOMER_SOURCES = new Set([
  'preference_centre', 'unsubscribe_one_click', 'one_click_unsubscribe',
  'postmark_one_click_unsubscribe', 'whatsapp_keyword', 'meta_user_preferences',
  'booking_form', 'event_form', 'waitlist_form', 'host_mailing_list', 'whatsapp_flow',
])

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
      <div className="w-full flex items-center justify-between gap-2 hover:bg-un1t-border/10 rounded-lg">
        <button
          type="button"
          onClick={toggle}
          className="flex-1 flex items-center gap-2 p-4 text-left"
        >
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
        </button>
        {/* GAPS-P6 — the subject-access-request download. A plain <a> with
            `download`, deliberately NOT <Link> and not a fetch: this points at
            an /api route that answers with a text/csv attachment, so the
            client router has nothing to render and would only get in the way,
            while the browser streams it straight to disk with the session
            cookie attached. Always available — answering a SAR must not
            require expanding a collapsed card first. */}
        <a
          href={`/api/contacts/${contactId}/consent-log?format=csv`}
          download
          className="mr-4 inline-flex items-center gap-1.5 px-2 py-1 rounded border border-un1t-border text-[11px] text-un1t-subtle hover:bg-un1t-border/20"
          title="Download this contact's full consent history as CSV (subject-access request)"
        >
          <Download size={11} /> Export CSV
        </a>
      </div>

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
                      <th className="py-1.5 pr-3 font-medium">Location</th>
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
                            {r.location_name || <span className="text-un1t-muted">—</span>}
                          </td>
                          <td className="py-1.5 pr-3 text-un1t-subtle">
                            {r.performed_by_name || (
                              <span className="text-un1t-muted italic">
                                {CUSTOMER_SOURCES.has(r.source) ? 'customer' : 'system'}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* CONSENT-COPY.1 — this used to tell the operator to query
                  consent_log directly, which was the only answer before GAPS-P6
                  shipped the export. It is now wrong advice on the page that
                  answers subject-access requests: the person reading it has a
                  button two inches away that returns the whole history,
                  uncapped, and does not have database access anyway. */}
              {truncated && (
                <p className="text-[11px] text-amber-700 mt-2">
                  Showing the most recent 500 events. Use <b>Export CSV</b> above for this
                  contact&apos;s complete history.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
