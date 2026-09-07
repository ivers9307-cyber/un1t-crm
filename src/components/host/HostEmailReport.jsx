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
// HOST-RESEND.1 — a sent campaign's header carries "Resend to N who missed
// it" (N = `campaign.missed_count` from the recipients route, the same diff
// the resend route enqueues with). Confirm → POST /api/host/emails/[id]/
// resend-missed → re-fetch, so the page flips to "Still sending" with the
// queued rows in the table. missed_count 0 hides the button; null (the diff
// failed) keeps it, uncounted, and lets the server answer. The header reads
// "Sent <first sent_at>" and, after a resend has drained, "Resent
// <resent_at>" (mig 593). Resent rows keep their own sent_at in the table.
//
// Dark UN1T host-portal styling (bg-black page; chips use the -300 dark-chip
// ramp, tiles are the `rounded-xl border border-white/10 bg-white/[0.03]`
// recipe used across the portal).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { dublinScheduleLabel, scheduleErrorCopy } from '@/lib/host-schedule-time'

const AUDIENCE_LABEL = {
  all: 'All contacts',
  mailing_list: 'Mailing list signups',
  event: 'Event attendees',
  non_openers: "People who didn't open the original email",
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

/**
 * Header button label. A known count reads "Resend to 44 who missed it"; an
 * unknown one (the diff failed server-side, missed_count null) drops the
 * number rather than inventing one. Callers hide the button at 0.
 * @param {number|null|undefined} missedCount
 */
export function resendLabel(missedCount) {
  if (missedCount == null) return 'Resend to those who missed it'
  return `Resend to ${missedCount} who missed it`
}

/**
 * The window.confirm copy behind the button. Plain sentences, no dashes.
 * @param {number|null|undefined} missedCount
 */
export function resendConfirmCopy(missedCount) {
  const who = missedCount == null
    ? 'everyone who did not receive it'
    : `the ${missedCount} ${missedCount === 1 ? 'person' : 'people'} who did not receive it`
  return `Send this email again to ${who}? Anyone who already got it will not be emailed twice.`
}

/**
 * Header button label for the "email who didn't open" reminder.
 * @param {number} count
 */
export function reminderLabel(count) {
  return `Send a reminder to ${count} who didn't open`
}

/**
 * The window.confirm copy behind the reminder button. Under 24h since the
 * original send, adds a note that opens are still trickling in — a
 * reminder that soon can reach people who simply haven't got to it yet.
 * @param {number} count
 * @param {string|null|undefined} sentAt
 * @param {number} [nowMs]
 */
export function reminderConfirmCopy(count, sentAt, nowMs = Date.now()) {
  const who = `${count} ${count === 1 ? 'person' : 'people'}`
  const base = `Create a reminder draft for the ${who} who didn't open this email? You can edit it before sending.`
  const sentMs = sentAt ? Date.parse(sentAt) : NaN
  const young = Number.isFinite(sentMs) && nowMs - sentMs < 24 * 3600 * 1000
  return young ? `${base} Opens keep arriving for a day or two. A reminder this soon reaches people who may simply not have got to it yet.` : base
}

/**
 * The "Paused. <reason>. Ask UN1T." line for a sending campaign the
 * scheduler has stalled on. Empty string when there is no reason (the
 * normal "still sending" case).
 * @param {string|null|undefined} reason
 */
export function pausedCopy(reason) {
  return reason ? `Paused. ${scheduleErrorCopy(reason)}. Ask UN1T.` : ''
}

const HOUR_MS = 60 * 60 * 1000

export default function HostEmailReport({ campaignId }) {
  const [state, setState] = useState('loading') // 'loading' | 'error' | 'not_found' | 'ready'
  const [campaign, setCampaign] = useState(null)
  const [recipients, setRecipients] = useState([])
  const [links, setLinks] = useState([])
  const [filter, setFilter] = useState('all')
  const [reloadKey, setReloadKey] = useState(0)
  const [resending, setResending] = useState(false)
  const [reminding, setReminding] = useState(false)
  const [navigating, setNavigating] = useState(false)
  const [actionError, setActionError] = useState('')
  const router = useRouter()

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
        setLinks(Array.isArray(json.data?.links) ? json.data.links : [])
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    }
    load()
    return () => { cancelled = true }
  }, [campaignId, reloadKey])

  async function resendMissed() {
    if (!campaign) return
    if (!window.confirm(resendConfirmCopy(campaign.missed_count))) return
    setResending(true)
    setActionError('')
    try {
      const res = await fetch(`/api/host/emails/${campaignId}/resend-missed`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setActionError(json.error || 'Could not resend this email.')
        return
      }
      // Re-fetch rather than patch state: the queued rows, the counts and
      // the "Still sending" note all come from the recipients route.
      setReloadKey((k) => k + 1)
    } catch {
      setActionError('Could not resend this email.')
    } finally {
      setResending(false)
    }
  }

  async function createReminder() {
    if (!campaign) return
    if (!window.confirm(reminderConfirmCopy(campaign.non_openers_count, campaign.sent_at))) return
    setReminding(true)
    setActionError('')
    try {
      const res = await fetch(`/api/host/emails/${campaignId}/reminder-draft`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setActionError(json.error || 'Could not create the reminder.')
        setReminding(false)
        return
      }
      // Leave `reminding` (and the button) disabled on the success path —
      // router.push() returns before navigation completes, so resetting it
      // in a `finally` here would re-enable the button while the page is
      // still this one and let a second click queue a second draft.
      setNavigating(true)
      router.push('/host/emails?notice=reminder')
    } catch {
      setActionError('Could not create the reminder.')
      setReminding(false)
    }
  }

  if (state === 'loading') return <p className="text-white/40 text-sm mt-6">Loading…</p>
  if (state === 'not_found') return <p className="text-white/50 text-sm mt-6">This email was not found.</p>
  if (state === 'error') return <p className="text-white/50 text-sm mt-6">Could not load this email.</p>

  const hasStats = campaign?.stats != null
  const tiles = hasStats ? statTiles(campaign.stats) : null
  const filtered = filterRecipients(recipients, filter)
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, filterRecipients(recipients, f.key).length]))

  const sentAt = campaign?.sent_at
  const whenStr = formatWhen(sentAt)
  const resentStr = formatWhen(campaign?.resent_at)
  const scheduledStr = dublinScheduleLabel(campaign?.scheduled_for)
  const headerBits = [
    whenStr && `Sent ${whenStr}`,
    resentStr && `Resent ${resentStr}`,
    scheduledStr && `Scheduled for ${scheduledStr}`,
    AUDIENCE_LABEL[campaign?.audience_kind] || 'All contacts',
  ].filter(Boolean)
  const canResend = campaign?.status === 'sent' && campaign?.missed_count !== 0
  const canRemind = campaign?.status === 'sent' && Number(campaign?.non_openers_count) > 0
  const staleNoDelivery = hasStats
    && campaign?.status === 'sent'
    && (campaign.stats.delivered || 0) === 0
    && sentAt
    && (Date.now() - new Date(sentAt).getTime()) > HOUR_MS

  return (
    <div>
      <div className="mt-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">{campaign?.subject || ''}</h1>
          <div className="flex items-center gap-2 shrink-0">
            {canResend && (
              <button
                type="button"
                onClick={resendMissed}
                disabled={resending}
                className="shrink-0 rounded-full bg-white text-black px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                {resending ? 'Queueing…' : resendLabel(campaign.missed_count)}
              </button>
            )}
            {canRemind && (
              <button
                type="button"
                onClick={createReminder}
                disabled={reminding || navigating}
                className="shrink-0 rounded-full border border-white/25 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                {reminding ? 'Creating…' : reminderLabel(campaign.non_openers_count)}
              </button>
            )}
          </div>
        </div>
        {actionError && <p className="text-red-300 text-xs mt-2">{actionError}</p>}
        <p className="text-white/55 text-sm mt-1 flex items-center gap-2 flex-wrap">
          <span>{headerBits.join(' · ')}</span>
          {campaign?.email_type === 'utility' && (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-sky-500/15 text-sky-300">
              Utility
            </span>
          )}
        </p>
        {campaign?.status === 'sending' && (
          <p className="text-amber-300 text-xs mt-2">
            {campaign.paused_reason ? pausedCopy(campaign.paused_reason) : 'Still sending, numbers update as it goes.'}
          </p>
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

      {links.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-2">Links</h2>
          <div className="rounded-xl border border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                  <th className="px-3 py-2 font-medium">Link</th>
                  <th className="px-3 py-2 font-medium text-right">Clicks</th>
                  <th className="px-3 py-2 font-medium text-right">People</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.url} className="border-b border-white/5 last:border-0">
                    <td className="px-3 py-2 max-w-[28rem] truncate text-white/80" title={l.url}>{l.is_unsubscribe ? 'Unsubscribe link' : l.url}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.clicks}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.people}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-white/35 mt-1">Security scanners open every link within seconds of delivery, so counts include them.</p>
        </section>
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
