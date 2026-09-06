'use client'

// HOST-METRICS.1 — the per-email report page for the host portal. Reads
// GET /api/host/emails/[id]/recipients (Task 8) and renders the stat tiles,
// filter chips, and recipient table that HostEmails' list rows link to once
// a send has gone out (draft rows have nothing to report yet).
//
// Pure helpers (statTiles, filterRecipients, FILTERS, outcomeChipClass,
// formatWhen) are exported and unit-tested directly — the repo's host
// component convention, since jsdom cannot measure the layout this renders.
// The seven tiles and the filter chips both slice the SAME cumulative
// funnel host_campaign_stats() (mig 591) computes server-side — they must
// reconcile. The per-row outcome chip is a different, EXCLUSIVE view (one
// outcome per recipient) and is not used to derive either.
//
// `campaign.stats` can be null (recipients route) or absent (list) when the
// stats RPC fails — the tiles grid then gives way to a plain "unavailable"
// line rather than a wall of zeros that reads as "nobody opened this".
//
// Dark UN1T host-portal styling (bg-black page; chips use the -300 dark-chip
// ramp, tiles are the `rounded-xl border border-white/10 bg-white/[0.03]`
// recipe used across the portal).

import { useEffect, useState } from 'react'

const AUDIENCE_LABEL = {
  all: 'All contacts',
  mailing_list: 'Mailing list signups',
  event: 'Event attendees',
}

const WHEN_FORMATTER = new Intl.DateTimeFormat('en-IE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Dublin',
})

/**
 * '2026-09-04T10:58:14Z' -> '4 Sept, 11:58'. Null-safe (no sent_at, no
 * outcome timestamp yet) — returns '' rather than throwing or printing
 * "Invalid Date".
 * @param {string|null|undefined} iso
 */
export function formatWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return WHEN_FORMATTER.format(d)
}

/**
 * The seven headline tiles, in display order. Open/click rates are a share
 * of DELIVERED (not sent) — a bounce shouldn't dilute the open rate. Missing
 * stats (old rows, or a still-queued send) read as zero rather than NaN.
 * The caller must not invoke this when stats is genuinely null/absent (the
 * RPC failed) — that renders the "unavailable" line instead of a zeroed
 * grid, but this pure helper keeps returning zeros for `undefined` since
 * other callers (and its tests) rely on that.
 * @param {object|undefined} stats
 */
export function statTiles(stats) {
  const s = stats || {}
  const delivered = s.delivered || 0
  const rate = (n) => (delivered > 0 ? Math.min(100, Math.round(((n || 0) / delivered) * 100)) : 0)
  return [
    { key: 'sent', label: 'Sent', value: s.sent || 0 },
    { key: 'delivered', label: 'Delivered', value: delivered },
    { key: 'opened', label: 'Opened', value: s.opened || 0, sub: `${rate(s.opened)}% of delivered` },
    { key: 'clicked', label: 'Clicked', value: s.clicked || 0, sub: `${rate(s.clicked)}% of delivered` },
    { key: 'bounced', label: 'Bounced', value: s.bounced || 0 },
    { key: 'unsubscribed', label: 'Unsubscribed', value: s.unsubscribed || 0 },
    { key: 'failed', label: 'Failed', value: s.failed || 0 },
  ]
}

// The seven filter chips, in display order (matches the tiles above minus
// Sent/Delivered, which aren't useful ways to slice the recipient table, and
// plus "All" / "Not opened").
export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'opened', label: 'Opened' },
  { key: 'clicked', label: 'Clicked' },
  { key: 'not_opened', label: 'Not opened' },
  { key: 'bounced', label: 'Bounced' },
  { key: 'unsubscribed', label: 'Unsubscribed' },
  { key: 'failed', label: 'Failed' },
]

/**
 * Slice the recipient list for one filter chip. Every filter is a predicate
 * on the raw columns the recipients API sends (sent_at, delivered_at,
 * opened_at, clicked_at, bounced_at, complained_at, unsubscribed_at,
 * failed_reason, outcome), matching host_campaign_stats() (mig 591) exactly
 * so a chip's count agrees with the tile above it — a cumulative funnel
 * (clicked implies opened, opened implies delivered), NOT the per-row
 * `outcome` column, which is exclusive and would undercount "opened" by
 * excluding anyone who went on to click. Because the funnel isn't exclusive,
 * one recipient can legitimately appear under more than one chip — someone
 * who opened and later unsubscribed shows up under BOTH.
 *
 * The recipients API doesn't send `status` (mig 591's own guard column) —
 * `r.outcome !== 'failed'` stands in for it, since 'failed' is the only
 * outcome a non-'sent' status can produce here.
 * @param {Array<object>} recipients
 * @param {string} filter  one of FILTERS' keys
 */
export function filterRecipients(recipients, filter) {
  const rows = recipients || []
  switch (filter) {
    case 'opened':
      return rows.filter((r) => r.outcome !== 'failed' && r.opened_at && !r.bounced_at && !r.complained_at)
    case 'clicked':
      return rows.filter((r) => r.outcome !== 'failed' && r.clicked_at && !r.bounced_at && !r.complained_at)
    case 'not_opened':
      return rows.filter((r) => r.outcome !== 'failed' && r.delivered_at && !r.opened_at && !r.bounced_at && !r.complained_at)
    case 'bounced':
      return rows.filter((r) => r.outcome !== 'failed' && r.bounced_at)
    case 'unsubscribed':
      return rows.filter((r) => r.outcome !== 'failed' && r.unsubscribed_at && !r.bounced_at && !r.complained_at)
    case 'failed':
      return rows.filter((r) => r.outcome === 'failed')
    case 'all':
    default:
      return rows
  }
}

const OUTCOME_CHIP = {
  failed: 'bg-red-500/15 text-red-300',
  bounced: 'bg-red-500/15 text-red-300',
  complained: 'bg-red-500/15 text-red-300',
  unsubscribed: 'bg-amber-500/15 text-amber-300',
  clicked: 'bg-emerald-500/15 text-emerald-300',
  opened: 'bg-sky-500/15 text-sky-300',
  delivered: 'bg-white/10 text-white/70',
  sent: 'bg-white/10 text-white/70',
  queued: 'bg-white/5 text-white/40',
}

/**
 * Chip class for one recipient's outcome. Never returns undefined — an
 * unrecognised outcome falls back to the same muted class as "queued".
 * @param {string} outcome
 */
export function outcomeChipClass(outcome) {
  return OUTCOME_CHIP[outcome] || 'bg-white/5 text-white/40'
}

const chipCls = (o) => `rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${outcomeChipClass(o)}`

const HOUR_MS = 60 * 60 * 1000

export default function HostEmailReport({ campaignId }) {
  const [state, setState] = useState('loading') // 'loading' | 'error' | 'not_found' | 'ready'
  const [campaign, setCampaign] = useState(null)
  const [recipients, setRecipients] = useState([])
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setState('loading')
      try {
        const res = await fetch(`/api/host/emails/${campaignId}/recipients`, { cache: 'no-store' })
        if (cancelled) return
        if (res.status === 404) { setState('not_found'); return }
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok || !json.success) { setState('error'); return }
        setCampaign(json.data?.campaign || null)
        setRecipients(Array.isArray(json.data?.recipients) ? json.data.recipients : [])
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    }
    load()
    return () => { cancelled = true }
  }, [campaignId])

  if (state === 'loading') return <p className="text-white/40 text-sm mt-6">Loading…</p>
  if (state === 'not_found') return <p className="text-white/50 text-sm mt-6">This email was not found.</p>
  if (state === 'error') return <p className="text-white/50 text-sm mt-6">Could not load this email.</p>

  const hasStats = campaign?.stats != null
  const tiles = hasStats ? statTiles(campaign.stats) : null
  const filtered = filterRecipients(recipients, filter)
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, filterRecipients(recipients, f.key).length]))

  const sentAt = campaign?.sent_at
  const whenStr = formatWhen(sentAt)
  const staleNoDelivery = hasStats
    && campaign?.status === 'sent'
    && (campaign.stats.delivered || 0) === 0
    && sentAt
    && (Date.now() - new Date(sentAt).getTime()) > HOUR_MS

  return (
    <div>
      <div className="mt-3">
        <h1 className="text-2xl font-bold">{campaign?.subject || ''}</h1>
        <p className="text-white/55 text-sm mt-1 flex items-center gap-2 flex-wrap">
          {whenStr && <span>{whenStr}</span>}
          {whenStr && <span>·</span>}
          <span>{AUDIENCE_LABEL[campaign?.audience_kind] || 'All contacts'}</span>
          {campaign?.email_type === 'utility' && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-sky-500/15 text-sky-300">
              Utility
            </span>
          )}
        </p>
        {campaign?.status === 'sending' && (
          <p className="text-amber-300 text-xs mt-2">Still sending, numbers update as it goes.</p>
        )}
        {staleNoDelivery && (
          <p className="text-red-300 text-xs mt-2">Nothing delivered yet. If this persists, contact UN1T.</p>
        )}
      </div>

      {hasStats ? (
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {tiles.map((t) => (
            <div key={t.key} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <p className="text-[11px] uppercase tracking-wide text-white/40">{t.label}</p>
              <p className="text-lg font-semibold mt-1 tabular-nums">{t.value}</p>
              {t.sub && <p className="text-[11px] text-white/40 mt-0.5">{t.sub}</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-6 text-white/50 text-sm">
          Counts are unavailable right now. The recipient list below is still complete.
        </p>
      )}

      <div className="mt-6 flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.key ? 'bg-white text-black' : 'border border-white/20 text-white/70'
            }`}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      <section className="mt-4">
        {filtered.length === 0 ? (
          <p className="text-white/50 text-sm mt-4">No recipients.</p>
        ) : (
          <div className="rounded-xl border border-white/10 overflow-hidden">
            <table className="hidden sm:table w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                  <th className="px-3 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.contact_id} className="border-b border-white/5 last:border-0 align-top">
                    <td className="px-3 py-2">{r.name || ''}</td>
                    <td className="px-3 py-2 text-white/70">{r.email}</td>
                    <td className="px-3 py-2">
                      <span className={chipCls(r.outcome)}>{r.outcome}</span>
                      {r.outcome === 'failed' && r.failure_copy && (
                        <p className="text-xs text-white/45 mt-1">{r.failure_copy}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-white/55">{formatWhen(r.outcome_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="sm:hidden divide-y divide-white/10">
              {filtered.map((r) => (
                <li key={r.contact_id} className="px-4 py-3">
                  <p className="flex items-center justify-between gap-2">
                    <span className="truncate">{r.name || r.email || ''}</span>
                    <span className={chipCls(r.outcome)}>{r.outcome}</span>
                  </p>
                  <p className="text-xs text-white/45 mt-0.5">{r.email}</p>
                  {r.outcome === 'failed' && r.failure_copy && (
                    <p className="text-xs text-white/45 mt-1">{r.failure_copy}</p>
                  )}
                  <p className="text-xs text-white/40 mt-1">{formatWhen(r.outcome_at)}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}
