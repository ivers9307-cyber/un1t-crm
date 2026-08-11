'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import {
  Mail, Eye, MousePointerClick, AlertTriangle,
  Ban, Send, CheckCircle2, XCircle, Users, RotateCcw, X, Clock, SkipForward, Loader2, Copy
} from 'lucide-react'
import SendDetailHeader from './communications/SendDetailHeader'
import SendStatusPill from './communications/SendStatusPill'
// COMMSFIX.F.4 — per-link click report (mig 510), self-contained so this
// file's diff stays small while #1314 rewrites the header/controls region.
import CampaignLinkReport from './CampaignLinkReport.jsx'
import CampaignOutcomeReport from './CampaignOutcomeReport.jsx'
// ABHONEST.1 — the panel re-reads the same variant stats the sender decided on,
// because campaigns.ab_winner cannot record "inconclusive" (mig 398's CHECK
// allows only 'a'|'b'|NULL). The stamp says what was SENT; this says what the
// numbers support, and the two are shown separately when they disagree.
import { decideAbOutcome } from '@/lib/campaign-ab'
// REPORT-SOT.2 — every figure on this page is counted from campaign_recipients.
// campaigns.total_* is still written and still on disk; it is just no longer
// what an operator reads. See campaign-display-stats.js for the measurements.
import { campaignDisplayStats, NO_RECIPIENT_STATS, pct } from '@/lib/campaign-display-stats'

// COMMSFIX.D.1a — the header chip used to be a hardcoded green "Sent" for
// every campaign, including scheduled/queued/sending/cancelled ones — i.e. it
// lied in exactly the states where the operator is deciding whether to
// intervene. COMMS-DETAIL-FIX.4 moved the map itself to
// src/lib/send-status-display.js (values unchanged) so SMS and WhatsApp render
// the same labels and the same light-theme chip recipe instead of each doing
// their own thing; SendStatusPill is the shared renderer.

// COMMSFIX.D.1c — pre-send and terminal-skip statuses were missing, and the
// lookup fell back to `sent` — so a queued, mid-send, cancelled or
// frequency-capped recipient all rendered as a green "Sent" row.
const recipientStatusConfig = {
  queued:    { label: 'Queued',     icon: Clock,           color: 'text-amber-700' },
  sending:   { label: 'Sending',    icon: Loader2,         color: 'text-amber-700' },
  sent:      { label: 'Sent',       icon: Send,            color: 'text-blue-400' },
  delivered: { label: 'Delivered',  icon: CheckCircle2,    color: 'text-green-400' },
  opened:    { label: 'Opened',     icon: Eye,             color: 'text-emerald-400' },
  clicked:   { label: 'Clicked',    icon: MousePointerClick, color: 'text-cyan-400' },
  bounced:   { label: 'Bounced',    icon: XCircle,         color: 'text-red-400' },
  failed:    { label: 'Failed',     icon: AlertTriangle,   color: 'text-red-400' },
  complained:{ label: 'Complained', icon: Ban,             color: 'text-orange-400' },
  cancelled: { label: 'Cancelled',  icon: X,               color: 'text-rose-700' },
  // FREQ-CAP.1 terminal skip — not an error, and never retried.
  skipped_frequency_cap: { label: 'Skipped (frequency cap)', icon: SkipForward, color: 'text-un1t-subtle' },
}

function StatCard({ icon: Icon, label, value, subValue, color }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className={color || 'text-un1t-subtle'} />
        <span className="text-xs text-un1t-subtle uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {subValue && <p className="text-xs text-un1t-muted mt-0.5">{subValue}</p>}
    </div>
  )
}

// CAMPAIGN-AB — human-readable test state derived from the campaign's
// ab_* columns (mig 398); mirrors resolveAbPhase in src/lib/campaign-ab.js.
function abStateFor(campaign) {
  if (!campaign.ab_subject_b) return null
  if (campaign.ab_winner) return 'decided'
  if (campaign.ab_test_started_at) return 'waiting'
  return 'testing'
}

function AbVariantRow({ label, subject, stats, isWinner }) {
  const sent = Number(stats?.sent_count) || 0
  const opened = Number(stats?.opened_count) || 0
  const openRate = sent > 0 ? ((opened / sent) * 100).toFixed(1) : '0'
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-un1t-subtle uppercase">{label}</span>
          {isWinner && (
            <span className="text-xs bg-emerald-500/10 text-emerald-700 px-2 py-0.5 rounded-full">Winner</span>
          )}
        </div>
        <p className="text-sm text-un1t-text truncate">{subject || '—'}</p>
      </div>
      <div className="flex items-center gap-4 text-sm shrink-0 tabular-nums">
        <span className="text-un1t-subtle">{sent} sent</span>
        <span className="text-un1t-subtle">{opened} opened</span>
        <span className="font-semibold">{openRate}%</span>
      </div>
    </div>
  )
}

export default function CampaignDetail({ campaign, recipients = [], stats = null, abStats = null, resendChild = null, resendParent = null, locationId: _locationId, userId: _userId }) {
  const router = useRouter()
  const db = createBrowserClient()
  const [tab, setTab] = useState('overview')  // overview, recipients, preview
  // COMMSFIX.D.1b — stop/resend state. `status` is local so the header
  // reflects the write immediately, before router.refresh() lands.
  const [status, setStatus] = useState(campaign.status)
  const [stopBusy, setStopBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  // CAMPAIGN-RESEND — cancel-pending-resend state (the child doesn't
  // exist yet, so cancelling is just clearing the parent's flag).
  const [resendBusy, setResendBusy] = useState(false)
  const [resendCancelled, setResendCancelled] = useState(false)

  const resendPending = campaign.resend_enabled && !resendChild && !resendCancelled
  const resendDueAt = campaign.sent_at && campaign.resend_wait_hours
    ? new Date(new Date(campaign.sent_at).getTime() + campaign.resend_wait_hours * 3_600_000)
    : null

  async function cancelResend() {
    setResendBusy(true)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/resend`, { method: 'DELETE' })
      if (res.ok) {
        setResendCancelled(true)
        router.refresh()
      }
    } finally {
      setResendBusy(false)
    }
  }

  // COMMSFIX.D.1b — stop a scheduled/queued/sending campaign from the page the
  // composer actually links to. Same mechanism CampaignEditor.handleCancel
  // uses (browser client, direct campaigns write): 'scheduled' flips back to
  // draft so the cron stops treating it as a promotion candidate; 'queued' /
  // 'sending' stamp cancel_requested_at, which the run-campaigns cron sees
  // between chunks. Until this existed the ONLY cancel control lived behind
  // the undiscoverable ?edit=1 query param.
  const stoppable = ['scheduled', 'queued', 'sending'].includes(status)

  // CAMPHIST.1 — the reuse control. Before this the ONLY way to reuse a
  // campaign was to hand-type ?edit=1, which opened the editor on the sent
  // campaign itself and saved over it, leaving its recipients, opens and
  // clicks describing an email that was never sent. Duplicating gives a fresh
  // draft with the same creative and none of the parent's history, which is
  // what the send route's own comment has told operators to do since
  // CAMPAIGN.13 for a capability that did not exist.
  const [duplicating, setDuplicating] = useState(false)
  async function duplicateCampaign() {
    setDuplicating(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/duplicate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.success) {
        setActionError(json?.error || 'Could not duplicate this campaign.')
        return
      }
      router.push(`/communications/sent/email/${json.data.id}?edit=1`)
    } catch {
      setActionError('Could not duplicate this campaign.')
    } finally {
      setDuplicating(false)
    }
  }
  // REPORT-SOT.2 — every displayed figure on this page comes from
  // campaign_recipients via the server page. `stats` is never absent in the
  // app; the fallback keeps the component renderable on its own (and in the
  // tests that predate the prop), and campaignDisplayStats records which
  // source answered so the page can label a fallback rather than pass stored
  // counters off as recipient figures.
  const figures = stats || campaignDisplayStats(campaign, NO_RECIPIENT_STATS)
  const pendingCount = figures.recipients || figures.sent || 0

  async function stopCampaign() {
    const who = pendingCount ? `${pendingCount.toLocaleString()} recipients` : 'this audience'
    const ask = status === 'scheduled'
      ? `Unschedule "${campaign.name}"? It will go back to draft and will NOT send to ${who}.`
      : `Stop "${campaign.name}"? Sending to ${who} halts within a minute. Already-sent emails cannot be unsent.`
    if (!confirm(ask)) return
    setStopBusy(true)
    setActionError(null)
    try {
      const payload = status === 'scheduled'
        ? { status: 'draft', scheduled_at: null }
        : { cancel_requested_at: new Date().toISOString() }
      const { error } = await db.from('campaigns').update(payload).eq('id', campaign.id)
      if (error) throw new Error(error.message)
      if (status === 'scheduled') setStatus('draft')
      router.refresh()
    } catch (err) {
      setActionError(err?.message || 'Could not stop this campaign')
    } finally {
      setStopBusy(false)
    }
  }

  // COMMSFIX.D.1b — a campaign the cron marked 'failed' (fix/stats-integrity)
  // lands here, not in the editor, so the re-send path was unreachable. The
  // send route re-queues it and clears last_error. No-ops harmlessly on a
  // deployment where nothing is ever marked failed.
  async function resendFailed() {
    if (!confirm(`Try sending "${campaign.name}" again?`)) return
    setStopBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/send`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.success === false) throw new Error(data?.error || `Request failed (${res.status})`)
      setStatus('queued')
      router.refresh()
    } catch (err) {
      setActionError(err?.message || 'Could not re-queue this campaign')
    } finally {
      setStopBusy(false)
    }
  }

  // CAMPAIGN.4 — drafts are routed to <CampaignEditor> by the page.
  // If we somehow get here with a draft, send the user to the editor
  // explicitly rather than returning null and showing a blank page.
  if (campaign.status === 'draft') {
    if (typeof window !== 'undefined') {
      router.replace(`/communications/sent/email/${campaign.id}?edit=1`)
    }
    return (
      <div className="py-16 text-center text-un1t-subtle">
        Opening draft editor…
      </div>
    )
  }

  const totalSent = figures.sent
  const totalOpened = figures.opened
  const totalClicked = figures.clicked
  const totalBounced = figures.bounced

  const sentDate = campaign.sent_at
    ? new Date(campaign.sent_at).toLocaleDateString('en-IE', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    : 'Not sent yet'

  const tabs = [
    { key: 'overview',   label: 'Overview' },
    { key: 'recipients', label: `Recipients (${totalSent})` },
    { key: 'links',      label: 'Links' },
    { key: 'outcomes',   label: 'Outcomes' },
    { key: 'preview',    label: 'Preview' },
  ]

  return (
    <div>
      {/* COMMS-IA.1 — the shared send-detail chrome. This view used to take the
          full viewport with a top bar of its own; it now renders inside the
          Communications shell like its SMS and WhatsApp siblings. The campaign
          controls (stop / retry) are body state, so they ride in as actions. */}
      <SendDetailHeader
        channel="email"
        title={
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-un1t-text truncate">{campaign.name}</h2>
            <p className="text-xs text-un1t-subtle truncate">{campaign.subject || 'No subject'}</p>
          </div>
        }
        // COMMS-DETAIL-FIX.4 — the map this used to read privately now lives
        // in src/lib/send-status-display.js and all three channels render it
        // through SendStatusPill. Values are byte-identical, so email's chip
        // is unchanged; SMS and WhatsApp moved onto it. The test handle is
        // kept so the COMMSFIX.D.1a guard still has its target.
        status={<SendStatusPill status={campaign.status} title={campaign.last_error || undefined} testId="campaign-status-chip" />}
        meta={
          <>
            <p className="text-xs text-un1t-subtle">{sentDate}</p>
            {resendParent && (
              <p className="text-xs text-un1t-subtle flex items-center gap-1 mt-0.5">
                <RotateCcw size={11} />
                Resend of{' '}
                <Link href={`/communications/sent/email/${resendParent.id}`} className="underline hover:text-un1t-text">
                  {resendParent.name}
                </Link>
                {' '}(non-openers only)
              </p>
            )}
          </>
        }
        actions={
          <>
            {stoppable && (
              <button
                type="button"
                data-testid="campaign-cancel"
                onClick={stopCampaign}
                disabled={stopBusy || !!campaign.cancel_requested_at}
                className="flex items-center gap-1.5 text-xs text-rose-700 border border-un1t-border hover:border-rose-500/40 px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
              >
                {stopBusy ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                {campaign.cancel_requested_at
                  ? 'Cancelling…'
                  : status === 'scheduled' ? 'Unschedule' : 'Stop sending'}
              </button>
            )}
            <button
              type="button"
              data-testid="campaign-duplicate"
              onClick={duplicateCampaign}
              disabled={duplicating}
              title="Create an editable draft with the same subject, design and audience"
              className="flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
            >
              {duplicating ? <Loader2 size={13} className="animate-spin" /> : <Copy size={13} />}
              Duplicate
            </button>
            {status === 'failed' && (
              <button
                type="button"
                data-testid="campaign-resend-failed"
                onClick={resendFailed}
                disabled={stopBusy}
                className="flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border hover:border-un1t-text/30 px-3 py-1.5 rounded-md transition-colors disabled:opacity-40"
              >
                <RotateCcw size={13} />
                Try again
              </button>
            )}
          </>
        }
      />

      {(actionError || (status === 'failed' && campaign.last_error)) && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg text-red-700 text-sm px-3 py-2 mb-4">
          {actionError || `This campaign failed to send: ${campaign.last_error}`}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-un1t-border">
        {tabs.map(t => (
          <button
            type="button"
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'text-un1t-text border-un1t-text'
                : 'text-un1t-subtle border-transparent hover:text-un1t-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div>
        {tab === 'overview' && (
          <div className="p-6 space-y-6">
            {/* CAMPAIGN-RESEND — pending / fired resend state */}
            {resendPending && (
              <div className="bg-blue-500/[0.05] border border-blue-500/30 rounded-lg p-4 flex items-center justify-between gap-4">
                <div className="flex items-start gap-2.5 text-sm">
                  <RotateCcw size={16} className="text-blue-700 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-un1t-text font-medium">Resend to non-openers scheduled</p>
                    <p className="text-xs text-un1t-subtle mt-0.5">
                      {resendDueAt
                        ? <>Goes out around {resendDueAt.toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })} to everyone who hasn&apos;t opened by then</>
                        : <>Goes out {campaign.resend_wait_hours || '—'}h after this campaign finishes sending</>}
                      {campaign.resend_subject ? <> · subject: “{campaign.resend_subject}”</> : ' · same subject'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={cancelResend}
                  disabled={resendBusy}
                  className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-40 shrink-0"
                >
                  {resendBusy ? 'Cancelling…' : 'Cancel resend'}
                </button>
              </div>
            )}
            {resendChild && (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 flex items-center gap-2.5 text-sm">
                <RotateCcw size={16} className="text-un1t-subtle shrink-0" />
                <span className="text-un1t-subtle">
                  Resent to non-openers —{' '}
                  <Link href={`/communications/sent/email/${resendChild.id}`} className="text-un1t-text underline">
                    {resendChild.name}
                  </Link>
                  {resendChild.status !== 'sent' && <span className="capitalize"> ({resendChild.status})</span>}
                </span>
              </div>
            )}

            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={Send}              label="Sent"       value={totalSent} />
              <StatCard icon={Eye}               label="Opened"     value={totalOpened}  subValue={`${pct(figures.open_rate)} open rate`}   color="text-emerald-400" />
              <StatCard icon={MousePointerClick} label="Clicked"    value={totalClicked} subValue={`${pct(figures.click_rate)} click rate`} color="text-cyan-400" />
              <StatCard icon={AlertTriangle}     label="Bounced"    value={totalBounced} subValue={`${pct(figures.bounce_rate)} bounce rate`} color="text-red-400" />
            </div>

            {/* REPORT-SOT.2 — the figures above are counted from the recipient
                rows. Said once, plainly, because they will not match a number
                an operator remembers from before this change: the campaign
                counters missed every address the provider refused at send
                time. When the count could not be read the page says which
                source it fell back to rather than showing two sets. */}
            <p className="text-xs text-un1t-muted" data-testid="campaign-stats-source">
              {figures.source === 'recipients'
                ? 'Counted from the recipient list for this campaign, including addresses the provider refused at send time.'
                : 'Recipient figures could not be read just now. Showing the stored campaign counters, which do not include addresses the provider refused at send time.'}
            </p>

            {/* CAMPAIGN-AB — subject-line test panel (only when a
                variant B exists). Per-variant numbers come from the
                campaign_ab_variant_stats RPC via the server page. */}
            {campaign.ab_subject_b && (() => {
              const state = abStateFor(campaign)
              const statsFor = (v) => (abStats || []).find(r => r.ab_variant === v)
              // ABHONEST.1 — a tie, a slice nobody opened, or a gap under the
              // 1.5x bar is NOT a winner. Before this the panel printed
              // "Winner: Subject A" for all three, which is the product telling
              // an operator it learned something it did not.
              const reading = decideAbOutcome(abStats || [])
              const sentLetter = campaign.ab_winner === 'b' ? 'B' : 'A'
              const readingLetter = reading.outcome === 'b' ? 'B' : 'A'
              return (
                <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Subject A/B Test</h3>
                    {state === 'decided' && reading.outcome === 'inconclusive' && (
                      <span className="text-xs bg-slate-500/10 text-slate-700 px-2 py-0.5 rounded-full">
                        No clear winner. The rest were sent with Subject {sentLetter}
                      </span>
                    )}
                    {state === 'decided' && reading.outcome !== 'inconclusive' && readingLetter === sentLetter && (
                      <span className="text-xs bg-emerald-500/10 text-emerald-700 px-2 py-0.5 rounded-full">
                        Winner: Subject {sentLetter}
                      </span>
                    )}
                    {/* Opens keep arriving after the decision, so the reading
                        can move past the stamp. Say both rather than pick. */}
                    {state === 'decided' && reading.outcome !== 'inconclusive' && readingLetter !== sentLetter && (
                      <span className="text-xs bg-amber-500/10 text-amber-700 px-2 py-0.5 rounded-full">
                        Sent with Subject {sentLetter}. The numbers now favour Subject {readingLetter}
                      </span>
                    )}
                    {state === 'waiting' && (
                      <span className="text-xs bg-amber-500/10 text-amber-700 px-2 py-0.5 rounded-full">
                        Waiting — winner decided {campaign.ab_wait_hours || 4}h after the test slice
                      </span>
                    )}
                    {state === 'testing' && (
                      <span className="text-xs bg-blue-500/10 text-blue-700 px-2 py-0.5 rounded-full">
                        Test slice sending ({campaign.ab_test_pct || 10}% of audience)
                      </span>
                    )}
                  </div>
                  <div className="divide-y divide-un1t-border">
                    {/* The Winner pill follows the READING, not the stamp: a
                        pill on a variant that only won by default is the same
                        false claim in a smaller box. */}
                    <AbVariantRow
                      label="Subject A"
                      subject={campaign.subject}
                      stats={statsFor('a')}
                      isWinner={reading.outcome === 'a'}
                    />
                    <AbVariantRow
                      label="Subject B"
                      subject={campaign.ab_subject_b}
                      stats={statsFor('b')}
                      isWinner={reading.outcome === 'b'}
                    />
                  </div>
                  {state === 'decided' && (
                    <p className="mt-2 text-xs text-un1t-muted">{reading.reason}</p>
                  )}
                  {campaign.ab_decided_at && (
                    <p className="mt-1 text-xs text-un1t-muted">
                      Decided {new Date(campaign.ab_decided_at).toLocaleString('en-IE')}. The rest of the audience
                      received Subject {sentLetter}.
                    </p>
                  )}
                </div>
              )
            })()}

            {/* Campaign details */}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider mb-3">Campaign Details</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-un1t-muted">From</span>
                  <p>{campaign.from_name ? `${campaign.from_name} <${campaign.from_email}>` : campaign.from_email || '—'}</p>
                </div>
                <div>
                  <span className="text-un1t-muted">Reply To</span>
                  <p>{campaign.reply_to || 'Same as From'}</p>
                </div>
                <div>
                  <span className="text-un1t-muted">Preview Text</span>
                  <p>{campaign.preview_text || '—'}</p>
                </div>
                <div>
                  <span className="text-un1t-muted">Total Recipients</span>
                  <p>{figures.recipients || totalSent}</p>
                </div>
              </div>
            </div>

            {/* Audience filter summary */}
            {campaign.audience_filter?.filters?.length > 0 && (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
                <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider mb-3">Audience Filters</h3>
                <div className="space-y-1.5">
                  {campaign.audience_filter.filters.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      {i > 0 && (
                        <span className="text-xs text-un1t-muted font-medium uppercase">
                          {campaign.audience_filter.logic || 'and'}
                        </span>
                      )}
                      <span className="text-un1t-text">{f.field.replace(/_/g, ' ')}</span>
                      <span className="text-un1t-muted">{f.op.replace(/_/g, ' ')}</span>
                      {!['is_null', 'not_null'].includes(f.op) && (
                        <span className="text-blue-400">{f.value}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'recipients' && (
          <div className="p-6">
            {recipients.length === 0 ? (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
                <Users size={32} className="mx-auto mb-3 text-un1t-subtle" />
                <p className="text-sm text-un1t-subtle">No recipient data available yet</p>
              </div>
            ) : (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead>
                    <tr className="border-b border-un1t-border text-left text-xs text-un1t-subtle uppercase tracking-wider">
                      <th className="px-4 py-3">Contact</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Sent</th>
                      <th className="px-4 py-3">Opened</th>
                      <th className="px-4 py-3">Clicked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-un1t-border">
                    {recipients.map(r => {
                      const config = recipientStatusConfig[r.status]
                        || { label: r.status || 'Unknown', icon: AlertTriangle, color: 'text-un1t-subtle' }
                      const StatusIcon = config.icon
                      const contact = r.contacts

                      return (
                        <tr key={r.id} className="hover:bg-un1t-border/20 transition-colors">
                          <td className="px-4 py-3">
                            <div>
                              <Link
                                href={`/contacts/${r.contact_id}`}
                                className="text-un1t-text hover:underline"
                              >
                                {contact?.name || 'Unknown'}
                              </Link>
                              <p className="text-xs text-un1t-muted">{contact?.email || r.contact_id}</p>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span data-testid={`recipient-status-${r.id}`} className={`flex items-center gap-1.5 text-xs ${config.color}`}>
                              <StatusIcon size={12} />
                              {config.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-un1t-subtle">
                            {r.sent_at ? new Date(r.sent_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-un1t-subtle">
                            {r.opened_at ? new Date(r.opened_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-un1t-subtle">
                            {r.clicked_at ? new Date(r.clicked_at).toLocaleString('en-IE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'links' && (
          <div className="p-6">
            <CampaignLinkReport campaignId={campaign.id} />
          </div>
        )}

        {tab === 'outcomes' && (
          <div className="p-6">
            <CampaignOutcomeReport campaignId={campaign.id} />
          </div>
        )}

        {tab === 'preview' && (
          <div className="p-6">
            <div className="max-w-3xl mx-auto">
              <div className="bg-white rounded-lg overflow-hidden shadow-lg">
                {/* Email header bar */}
                <div className="bg-gray-100 px-4 py-3 border-b text-xs text-gray-600 space-y-1">
                  <p><strong>From:</strong> {campaign.from_name || 'UN1T'} &lt;{campaign.from_email || '...'}&gt;</p>
                  <p><strong>Subject:</strong> {campaign.subject || '(no subject)'}</p>
                  {campaign.preview_text && <p><strong>Preview:</strong> {campaign.preview_text}</p>}
                </div>
                {/* Email body */}
                {campaign.html_content ? (
                  <iframe
                    srcDoc={campaign.html_content}
                    title="Email preview"
                    className="w-full border-0"
                    style={{ minHeight: '600px' }}
                    sandbox="allow-same-origin"
                  />
                ) : (
                  <div className="p-12 text-center text-gray-400">
                    <Mail size={40} className="mx-auto mb-3" />
                    <p>No email content</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
