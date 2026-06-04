// /communications — landing/hub.
//
// Combined snapshot of email, WhatsApp, and SMS activity for the
// current location. Cards link into the sub-tabs. Stats only
// show for channels the user has permission for.

import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { Mail, MessageCircle, MessageSquare, Megaphone, Repeat, FileText, Inbox, Send } from 'lucide-react'

export const dynamic = 'force-dynamic'

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

  const db = createServerClient()
  const locationId = user.activeLocation?.id

  // Email stats
  let totalSent = 0, totalOpened = 0, openRate = 0, activeSequences = 0
  if (canEmail && locationId) {
    const [{ count: sent }, { count: opened }, { count: seqCount }] = await Promise.all([
      db.from('email_sends').select('id', { count: 'exact', head: true }).eq('location_id', locationId),
      db.from('email_sends').select('id', { count: 'exact', head: true }).eq('location_id', locationId).not('opened_at', 'is', null),
      db.from('email_sequences').select('id', { count: 'exact', head: true }).eq('location_id', locationId).eq('active', true),
    ])
    totalSent = sent || 0
    totalOpened = opened || 0
    openRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0
    activeSequences = seqCount || 0
  }

  // WhatsApp stats
  let unreadConvos = 0, draftBroadcasts = 0
  if (canWhatsapp && locationId) {
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
  let smsSent = 0, smsDelivered = 0, smsFailed = 0, smsSent30d = 0, smsDraftBroadcasts = 0, smsScheduled = 0
  if (canSms && locationId) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const [
      { data: totals },
      { data: last30 },
      { count: drafts },
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
        .eq('status', 'draft'),
      db.from('sms_broadcasts')
        .select('id', { count: 'exact', head: true })
        .eq('location_id', locationId)
        .eq('status', 'scheduled'),
    ])
    smsSent = (totals || []).reduce((acc, b) => acc + (b.total_sent || 0), 0)
    smsDelivered = (totals || []).reduce((acc, b) => acc + (b.total_delivered || 0), 0)
    smsFailed = (totals || []).reduce((acc, b) => acc + (b.total_failed || 0), 0)
    smsSent30d = (last30 || []).reduce((acc, b) => acc + (b.total_sent || 0), 0)
    smsDraftBroadcasts = drafts || 0
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
            <StatCard label="Open rate" value={`${openRate}%`} accent="text-green-500" />
            <StatCard label="Active sequences" value={activeSequences} icon={Repeat} />
          </>
        )}
        {canWhatsapp && (
          <>
            <StatCard label="Unread WhatsApp" value={unreadConvos} icon={Inbox} accent={unreadConvos > 0 ? 'text-amber-400' : undefined} />
            {!canEmail && <StatCard label="Draft broadcasts" value={draftBroadcasts} icon={Megaphone} />}
          </>
        )}
        {canSms && (
          <>
            <StatCard label="SMS sent" value={smsSent.toLocaleString()} icon={MessageSquare} accent={smsSent > 0 ? 'text-cyan-400' : undefined} />
            <StatCard label="SMS · last 30 days" value={smsSent30d.toLocaleString()} accent={smsSent30d > 0 ? 'text-cyan-400' : undefined} />
            {smsDeliveryRate !== null && (
              <StatCard
                label="Delivered (carrier-confirmed)"
                value={`${smsDeliveryRate}%`}
                accent={smsDeliveryRate >= 70 ? 'text-emerald-400' : 'text-amber-400'}
              />
            )}
            {smsFailureRate !== null && (
              <StatCard
                label="SMS failure rate"
                value={`${smsFailureRate}%`}
                accent={smsFailureRate > 5 ? 'text-red-400' : 'text-un1t-subtle'}
              />
            )}
          </>
        )}
      </div>

      {/* Quick actions */}
      <h3 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Jump in</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {(canSms || canWhatsapp) && (
          <ActionCard
            href="/communications/send"
            icon={Send}
            color="bg-un1t-text/10 text-un1t-text"
            title="Send a message"
            desc="Pick an audience, write once, send via SMS or WhatsApp"
          />
        )}
        {canWhatsapp && (
          <ActionCard
            href="/communications/inbox"
            icon={MessageCircle}
            color="bg-green-500/20 text-green-400"
            title="WhatsApp inbox"
            desc={unreadConvos > 0 ? `${unreadConvos} unread conversation${unreadConvos === 1 ? '' : 's'}` : 'View and reply to conversations'}
          />
        )}
        {canEmail && (
          <ActionCard
            href="/communications/sequences"
            icon={Repeat}
            color="bg-purple-500/20 text-purple-400"
            title="Sequences"
            desc={`${activeSequences} active drip flow${activeSequences === 1 ? '' : 's'}`}
          />
        )}
        {canEmail && (
          <ActionCard
            href="/communications/campaigns"
            icon={Mail}
            color="bg-blue-500/20 text-blue-400"
            title="Campaigns"
            desc="One-off email blasts"
          />
        )}
        {canSms && (
          <ActionCard
            href="/communications/sms/broadcasts"
            icon={MessageSquare}
            color="bg-cyan-500/20 text-cyan-400"
            title="SMS broadcasts"
            desc={
              smsScheduled > 0
                ? `${smsScheduled} scheduled, ${smsDraftBroadcasts} draft${smsDraftBroadcasts === 1 ? '' : 's'}`
                : smsDraftBroadcasts > 0
                  ? `${smsDraftBroadcasts} draft${smsDraftBroadcasts === 1 ? '' : 's'} pending`
                  : 'Freeform SMS to filtered audiences'
            }
          />
        )}
        {canWhatsapp && (
          <ActionCard
            href="/communications/broadcasts"
            icon={Megaphone}
            color="bg-amber-500/20 text-amber-400"
            title="Broadcasts"
            desc="Approved-template messages to filtered audiences"
          />
        )}
        <ActionCard
          href="/communications/templates"
          icon={FileText}
          color="bg-un1t-border/40 text-un1t-subtle"
          title="Templates"
          desc="Reusable email + WhatsApp content"
        />
      </div>
    </div>
  )
}
