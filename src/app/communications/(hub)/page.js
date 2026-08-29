// /communications — landing/hub.
//
// Combined snapshot of email, WhatsApp, and SMS activity for the
// current location. Stats only show for channels the user has
// permission for.
//
// DEEP.4 Task 2 (4B) — this stays the Messages landing (inbox/tickets are
// genuinely this hub's content), but 4 of its original 6 action cards
// (Send, Sent, Templates, List health) are now cross-links into
// communications/(marketing-era) — same URLs, different chrome on
// arrival (that group's own HubTabs strip, not this page). Their
// descriptions say so. WhatsApp inbox stays outright (Messages
// territory); Sequences stays outright too (an /automations cross-link
// that predates this PR and isn't part of the campaign-lifecycle move).
// The Mail card (né "Email inbox", RETIRE-TICKETS.1) deep-links the email
// surface.

import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { tierLabel, qualityAccent } from '@/lib/whatsapp-number-health'
import { loadEmailHubStats } from './email-hub-stats.js'
import { Mail, MessageCircle, MessageSquare, Megaphone, Repeat, FileText, Inbox, Send, ShieldCheck, Gauge } from 'lucide-react'

export const dynamic = 'force-dynamic'

// COMMSLAYOUT.5 — `accent` is text on a `bg-un1t-surface` card, i.e. a LIGHT
// surface: it must be the -700 ramp. Every caller below used -400/-500, which
// is the dark-theme idiom and washes out here. The ActionCards underneath
// already had it right (`bg-<c>-500/20 text-<c>-700`).
function StatCard({ label, value, icon: Icon, accent }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-un1t-subtle mb-2">
        {Icon && <Icon size={14} />}
        {label}
      </div>
      <div className={`text-2xl font-bold ${accent || 'text-un1t-text'}`}>{value}</div>
    </div>
  )
}

function ActionCard({ href, icon: Icon, color, title, desc }) {
  return (
    <Link
      href={href}
      className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 hover:border-un1t-text/30 transition-colors group"
    >
      <div className={`w-10 h-10 rounded-lg ${color} flex items-center justify-center mb-3`}>
        <Icon size={20} />
      </div>
      <div className="text-sm font-semibold text-un1t-text group-hover:text-un1t-accent">{title}</div>
      <div className="text-xs text-un1t-subtle mt-0.5">{desc}</div>
    </Link>
  )
}

export default async function CommunicationsHub() {
  const user = await getCurrentUser()
  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  // EMAIL-TICKET.4 key — the studio email surface, not the marketing `email`
  // one. Powers the Mail card below.
  const canEmailInbox = hasPermission(user, 'email_inbox')

  const db = createServerClient()
  const locationId = user.activeLocation?.id

  // Email stats — COMMSFIX.C.6 moved the queries into loadEmailHubStats so the
  // filters (status not the dead `active` column; broadcast-stream-only open
  // rate) are unit-testable.
  let totalSent = 0, openRate = 0, activeSequences = 0
  if (canEmail && locationId) {
    ({ totalSent, openRate, activeSequences } = await loadEmailHubStats(db, locationId))
  }

  // WhatsApp stats
  let unreadConvos = 0, draftBroadcasts = 0, waHealth = null
  if (canWhatsapp && locationId) {
    // Number health (Meta quality rating + messaging tier) — stored by the
    // refresh-whatsapp-health cron (mig 329). Default number for the location.
    const { data: num } = await db.from('whatsapp_numbers')
      .select('quality_rating, messaging_limit_tier, name_status, quality_checked_at')
      .eq('location_id', locationId).eq('is_active', true)
      .order('is_default', { ascending: false })
      .limit(1).maybeSingle()
    if (num) waHealth = num

    // Unread = conversations with unread inbound messages.
    const { count: unread } = await db
      .from('whatsapp_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .gt('unread_count', 0)
    unreadConvos = unread || 0

    const { count: drafts } = await db
      .from('whatsapp_broadcasts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('status', 'draft')
    draftBroadcasts = drafts || 0
  }

  // SMS stats (mig 060 + Phase 5C analytics).
  //
  // total_sent / total_failed at the broadcast level give us a fast
  // location-scoped view without scanning recipients. Recipient
  // counts (cross-location) would need a join via sms_broadcasts,
  // and that's expensive on the hub — keep the cheap path.
  let smsSent = 0, smsDelivered = 0, smsFailed = 0, smsSent30d = 0, smsScheduled = 0
  if (canSms && locationId) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const [
      { data: totals },
      { data: last30 },
      { count: scheduled },
    ] = await Promise.all([
      db.from('sms_broadcasts')
        .select('total_sent, total_delivered, total_failed')
        .eq('location_id', locationId)
        .in('status', ['sent', 'sending']),
      db.from('sms_broadcasts')
        .select('total_sent')
        .eq('location_id', locationId)
        .eq('status', 'sent')
        .gte('sent_at', thirtyDaysAgo),
      db.from('sms_broadcasts')
        .select('id', { count: 'exact', head: true })
        .eq('location_id', locationId)
        .eq('status', 'scheduled'),
    ])
    smsSent = (totals || []).reduce((acc, b) => acc + (b.total_sent || 0), 0)
    smsDelivered = (totals || []).reduce((acc, b) => acc + (b.total_delivered || 0), 0)
    smsFailed = (totals || []).reduce((acc, b) => acc + (b.total_failed || 0), 0)
    smsSent30d = (last30 || []).reduce((acc, b) => acc + (b.total_sent || 0), 0)
    smsScheduled = scheduled || 0
  }
  // Delivery rate as a percentage of sent (mig 065 — only meaningful
  // when carriers report DLRs; alpha-sender routes in IE/UK
  // under-report so this number floors below the real rate).
  const smsDeliveryRate = smsSent > 0
    ? Math.round((smsDelivered / smsSent) * 100)
    : null
  // Failure rate as a percentage — only meaningful when we've sent
  // anything. Hide otherwise to avoid a stat that says "NaN%".
  const smsFailureRate = (smsSent + smsFailed) > 0
    ? Math.round((smsFailed / (smsSent + smsFailed)) * 100)
    : null

  return (
    <div>
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {canEmail && (
          <>
            <StatCard label="Emails sent" value={totalSent.toLocaleString()} icon={Mail} />
            <StatCard label="Open rate" value={`${openRate}%`} accent="text-green-700" />
            <StatCard label="Active sequences" value={activeSequences} icon={Repeat} />
          </>
        )}
        {canWhatsapp && (
          <>
            <StatCard label="Unread WhatsApp" value={unreadConvos} icon={Inbox} accent={unreadConvos > 0 ? 'text-amber-700' : undefined} />
            {waHealth && (
              <>
                <StatCard
                  label="WhatsApp quality"
                  value={waHealth.quality_rating
                    ? waHealth.quality_rating.charAt(0) + waHealth.quality_rating.slice(1).toLowerCase()
                    : (waHealth.quality_checked_at ? 'Unavailable' : 'Checking…')}
                  icon={ShieldCheck}
                  accent={qualityAccent(waHealth.quality_rating)}
                />
                <StatCard label="Daily conversation limit" value={tierLabel(waHealth.messaging_limit_tier)} icon={Gauge} />
              </>
            )}
            {!canEmail && <StatCard label="Draft broadcasts" value={draftBroadcasts} icon={Megaphone} />}
          </>
        )}
        {canSms && (
          <>
            <StatCard label="SMS sent" value={smsSent.toLocaleString()} icon={MessageSquare} accent={smsSent > 0 ? 'text-cyan-700' : undefined} />
            <StatCard label="SMS · last 30 days" value={smsSent30d.toLocaleString()} accent={smsSent30d > 0 ? 'text-cyan-700' : undefined} />
            {smsDeliveryRate !== null && (
              <StatCard
                label="Delivered (carrier-confirmed)"
                value={`${smsDeliveryRate}%`}
                accent={smsDeliveryRate >= 70 ? 'text-emerald-700' : 'text-amber-700'}
              />
            )}
            {smsFailureRate !== null && (
              <StatCard
                label="SMS failure rate"
                value={`${smsFailureRate}%`}
                accent={smsFailureRate > 5 ? 'text-red-700' : 'text-un1t-subtle'}
              />
            )}
          </>
        )}
      </div>

      {/* Quick actions */}
      <h3 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Jump in</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {canWhatsapp && (
          <ActionCard
            href="/communications/inbox"
            icon={MessageCircle}
            color="bg-green-500/20 text-green-700"
            title="WhatsApp inbox"
            desc={unreadConvos > 0 ? `${unreadConvos} unread conversation${unreadConvos === 1 ? '' : 's'}` : 'View and reply to conversations'}
          />
        )}
        {/* NEW (DEEP.4 Task 2) — the ticket queue had a CommunicationsTabs
            tab but no landing card until now. */}
        {canEmailInbox && (
          <ActionCard
            href="/communications/mail"
            icon={Mail}
            color="bg-blue-500/20 text-blue-700"
            title="Mail"
            desc="Read and answer studio email (accounts@, sales@…)"
          />
        )}
        {canEmail && (
          <ActionCard
            href="/automations"
            icon={Repeat}
            color="bg-purple-500/20 text-purple-700"
            title="Sequences"
            desc={`${activeSequences} active drip flow${activeSequences === 1 ? '' : 's'}`}
          />
        )}
        {/* DEEP.4 Task 2 — the four cards below are cross-links: same URLs
            as always, but they now land in communications/(marketing-era),
            a Marketing-owned chrome (its own HubTabs strip), not this page's. */}
        {(canSms || canWhatsapp || canEmail) && (
          <ActionCard
            href="/communications/send"
            icon={Send}
            color="bg-un1t-text/10 text-un1t-text"
            title="Send a message"
            desc="Pick an audience, write once, send via SMS, WhatsApp or email — now in Marketing"
          />
        )}
        {(canSms || canWhatsapp || canEmail) && (
          <ActionCard
            href="/communications/sent"
            icon={Megaphone}
            color="bg-cyan-500/20 text-cyan-700"
            title="Sent"
            desc={
              smsScheduled > 0
                ? `${smsScheduled} scheduled · history of one-off sends — now in Marketing`
                : 'History of one-off SMS, WhatsApp & email sends — now in Marketing'
            }
          />
        )}
        {/* Rider (DEEP.4 Task 3) — templates/page.js redirects to /communications
            when !canEmail && !canWhatsapp (sms-only has neither), so an
            sms-only user must not see a card that bounces. */}
        {(canEmail || canWhatsapp) && (
          <ActionCard
            href="/communications/templates"
            icon={FileText}
            color="bg-un1t-border/40 text-un1t-subtle"
            title="Templates"
            desc="Reusable email + WhatsApp content — now in Marketing"
          />
        )}
        {/* GAPS-P5 — list-health also has a (marketing-era) tab now; this
            card stays as the landing's own pointer to it, same reasoning as
            every other cross-link card above. */}
        {canEmail && (
          <ActionCard
            href="/communications/list-health"
            icon={ShieldCheck}
            color="bg-amber-500/20 text-amber-700"
            title="List health"
            desc="Who can be emailed, bounces, and suppressed contacts — now in Marketing"
          />
        )}
      </div>
    </div>
  )
}
