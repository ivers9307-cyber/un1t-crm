'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import {
  ArrowLeft, Mail, Eye, MousePointerClick, AlertTriangle,
  Ban, Send, CheckCircle2, XCircle, Users, RotateCcw, X, Clock, SkipForward, Loader2
} from 'lucide-react'

// COMMSFIX.D.1a — the header chip used to be a hardcoded green "Sent" for
// every campaign, including scheduled/queued/sending/cancelled ones — i.e. it
// lied in exactly the states where the operator is deciding whether to
// intervene. Light-theme chip recipe per CLAUDE.md: bg-<c>-500/10 text-<c>-700.
// 'failed' is included ahead of the campaigns.last_error migration; it renders
// fine when the column/status don't exist yet (nothing ever has that status).
const campaignStatusConfig = {
  draft:     { label: 'Draft',     cls: 'bg-slate-500/10 text-slate-700' },
  scheduled: { label: 'Scheduled', cls: 'bg-blue-500/10 text-blue-700' },
  queued:    { label: 'Queued',    cls: 'bg-amber-500/10 text-amber-700' },
  sending:   { label: 'Sending',   cls: 'bg-amber-500/10 text-amber-700' },
  sent:      { label: 'Sent',      cls: 'bg-green-500/10 text-green-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-rose-500/10 text-rose-700' },
  failed:    { label: 'Failed',    cls: 'bg-red-500/10 text-red-700' },
}

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

export default function CampaignDetail({ campaign, recipients = [], abStats = null, resendChild = null, resendParent = null, locationId: _locationId, userId: _userId }) {
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
  const pendingCount = campaign.total_recipients || campaign.total_sent || 0

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
      router.replace(`/email/campaigns/${campaign.id}?edit=1`)
    }
    return (
      <div className="flex items-center justify-center h-screen text-un1t-subtle">
        Opening draft editor…
      </div>
    )
  }

  const totalSent = campaign.total_sent || campaign.total_recipients || 0
  const totalOpened = campaign.total_opened || 0
  const totalClicked = campaign.total_clicked || 0
  const totalBounced = campaign.total_bounced || 0
  const openRate = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : '0'
  const clickRate = totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : '0'
  const bounceRate = totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : '0'

  const statusChip = campaignStatusConfig[status] || campaignStatusConfig.draft

  const sentDate = campaign.sent_at
    ? new Date(campaign.sent_at).toLocaleDateString('en-IE', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    : 'Not sent yet'

  const tabs = [
    { key: 'overview',   label: 'Overview' },
    { key: 'recipients', label: `Recipients (${totalSent})` },
    { key: 'preview',    label: 'Preview' },
  ]

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-border bg-un1t-surface shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/email" className="text-un1t-subtle hover:text-un1t-text transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h2 className="text-lg font-semibold">{campaign.name}</h2>
            <p className="text-xs text-un1t-subtle">{campaign.subject || 'No subject'}</p>
            {resendParent && (
              <p className="text-xs text-un1t-subtle flex items-center gap-1 mt-0.5">
                <RotateCcw size={11} />
                Resend of{' '}
                <Link href={`/email/campaigns/${resendParent.id}`} className="underline hover:text-un1t-text">
                  {resendParent.name}
                </Link>
                {' '}— non-openers only
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-un1t-subtle">{sentDate}</span>
          <span
            data-testid="campaign-status-chip"
            title={campaign.last_error || undefined}
            className={`text-xs px-2 py-0.5 rounded-full ${statusChip.cls}`}
          >
            {statusChip.label}
          </span>
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
        </div>
      </div>

      {(actionError || (status === 'failed' && campaign.last_error)) && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-700 text-sm px-5 py-2 shrink-0">
          {actionError || `This campaign failed to send: ${campaign.last_error}`}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-un1t-border bg-un1t-surface shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
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
      <div className="flex-1 overflow-auto">
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
                  <Link href={`/email/campaigns/${resendChild.id}`} className="text-un1t-text underline">
                    {resendChild.name}
                  </Link>
                  {resendChild.status !== 'sent' && <span className="capitalize"> ({resendChild.status})</span>}
                </span>
              </div>
            )}

            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard icon={Send}              label="Sent"       value={totalSent} />
              <StatCard icon={Eye}               label="Opened"     value={totalOpened}  subValue={`${openRate}% open rate`}   color="text-emerald-400" />
              <StatCard icon={MousePointerClick} label="Clicked"    value={totalClicked} subValue={`${clickRate}% click rate`} color="text-cyan-400" />
              <StatCard icon={AlertTriangle}     label="Bounced"    value={totalBounced} subValue={`${bounceRate}% bounce rate`} color="text-red-400" />
            </div>

            {/* CAMPAIGN-AB — subject-line test panel (only when a
                variant B exists). Per-variant numbers come from the
                campaign_ab_variant_stats RPC via the server page. */}
            {campaign.ab_subject_b && (() => {
              const state = abStateFor(campaign)
              const statsFor = (v) => (abStats || []).find(r => r.ab_variant === v)
              return (
                <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Subject A/B Test</h3>
                    {state === 'decided' && (
                      <span className="text-xs bg-emerald-500/10 text-emerald-700 px-2 py-0.5 rounded-full">
                        Winner: Subject {campaign.ab_winner === 'b' ? 'B' : 'A'}
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
                    <AbVariantRow
                      label="Subject A"
                      subject={campaign.subject}
                      stats={statsFor('a')}
                      isWinner={campaign.ab_winner === 'a'}
                    />
                    <AbVariantRow
                      label="Subject B"
                      subject={campaign.ab_subject_b}
                      stats={statsFor('b')}
                      isWinner={campaign.ab_winner === 'b'}
                    />
                  </div>
                  {campaign.ab_decided_at && (
                    <p className="mt-2 text-xs text-un1t-muted">
                      Decided {new Date(campaign.ab_decided_at).toLocaleString('en-IE')} — the rest of the audience received the winning subject.
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
                  <p>{campaign.total_recipients || totalSent}</p>
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
