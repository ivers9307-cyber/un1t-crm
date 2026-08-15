// /communications/sent/[channel]/[id] — the ONE detail route for every send.
//
// COMMS-IA.1. The Sends table used to exit into three unrelated chromes:
//
//   SMS       /communications/sms/broadcasts/[id]   in the Communications shell
//   WhatsApp  /whatsapp/broadcasts/[id]             bare, outside the shell
//   Email     /email/campaigns/[id]                 full viewport, own top bar
//
// Three URL spaces, three headers, three back-links, two of them outside the
// hub the operator was working in. All three now resolve here: one segment
// under the list they came from, so the Communications layout (shell + tab
// strip, and its auth gate) wraps every one of them and SendDetailHeader gives
// them a single header and back-link.
//
// The BODIES stay per-channel — an SMS broadcast, a WhatsApp drip and an email
// campaign report genuinely different things — so this file is a dispatcher:
// auth, channel validation, the per-channel permission gate, then the loader
// for that channel. All three loaders live in this file rather than in sibling
// modules on purpose: check:location-scoping reads tenant scoping as
// FILE-LEVEL evidence (`assertLocationAccess(` anywhere in the page), so
// splitting them would move the guards out of the scanner's view.
//
// Old paths keep back-compat at the config level (legacy-redirects.js at
// the repo root, 307s), invariants tested in
// src/lib/legacy-redirects.test.js — those URLs are bookmarked and one of
// them is linked from notification email, so a 404 was never an option.

import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { overlayConnections } from '@/lib/connection-registry'
import { dripWindowStatus } from '@/lib/whatsapp-drip'
import { loadCampaignRecipientStats, campaignDisplayStats } from '@/lib/campaign-display-stats'
import { isCampaignContentEditable } from '@/lib/campaign-editability'
import {
  loadWhatsappBroadcastRecipientStats,
  countWhatsappSentToday,
  whatsappBroadcastDisplayStats,
} from '@/lib/whatsapp-broadcast-stats'
import SMSBroadcastEditor from '@/components/SMSBroadcastEditor'
import WABroadcastEditor from '@/components/WABroadcastEditor'
import CampaignDetail from '@/components/CampaignDetail'
import CampaignEditor from '@/components/CampaignEditor'

export const dynamic = 'force-dynamic'

// Channel → the permission that gates it. Same keys /communications/sent uses
// to decide whether a channel's rows appear in the list at all, so a row you
// can see is a row you can open and nothing else is reachable by typing a URL.
const CHANNEL_PERMISSION = { sms: 'sms', whatsapp: 'whatsapp', email: 'email' }

export default async function SendDetailPage(props) {
  const params = await props.params
  const searchParams = (await props.searchParams) || {}
  const { channel, id } = params

  const permission = CHANNEL_PERMISSION[channel]
  // An unrecognised channel is a 404, not a redirect: there is no sensible
  // "nearest" page and a redirect would confirm the segment shape.
  if (!permission) notFound()

  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, permission)) redirect('/communications')

  const db = createServerClient()

  if (channel === 'sms') return renderSms(db, user, id)
  if (channel === 'whatsapp') return renderWhatsapp(db, user, id)
  return renderEmail(db, user, id, searchParams)
}

// ── SMS ────────────────────────────────────────────────────────────
async function renderSms(db, user, id) {
  const { data: broadcast } = await db
    .from('sms_broadcasts')
    .select('*, locations:location_id(id, name, twilio_alpha_sender_id)')
    .eq('id', id)
    .single()

  // IDOR — 404 (not 403) so foreign ids aren't enumerable. This is a change
  // from the old /communications/sms/broadcasts/[id], which redirected to the
  // retired list on a foreign id and so confirmed the row existed; the two
  // sibling channels already did the right thing.
  if (!broadcast || assertLocationAccess(user, broadcast.location_id)) notFound()

  // INTEG-A2 dual-read: registry twilio_sender row first (sender preview
  // matches what sendBroadcast will actually use).
  if (broadcast.locations) {
    broadcast.locations = await overlayConnections(db, broadcast.locations, ['twilio_sender'])
  }

  // COMMS-DETAIL-FIX.5 — the contact join. Without it the recipients list had
  // nothing but contact_id and rendered a truncated UUID for every row, while
  // the email and WhatsApp lists both showed a person. `sms_broadcast_recipients`
  // has exactly one FK to contacts, so the bare embed is unambiguous (the
  // PGRST201 trap needs ≥2).
  const { data: recipients } = await db
    .from('sms_broadcast_recipients')
    .select('id, contact_id, status, twilio_message_sid, error_message, sent_at, failed_at, contacts(name, phone)')
    .eq('broadcast_id', id)
    .order('created_at', { ascending: false })
    .limit(500)

  return (
    <SMSBroadcastEditor
      broadcast={broadcast}
      recipients={recipients || []}
      locationId={broadcast.location_id}
      locationSenderId={broadcast.locations?.twilio_alpha_sender_id}
      userId={user.id}
    />
  )
}

// ── WhatsApp ───────────────────────────────────────────────────────
async function renderWhatsapp(db, user, id) {
  const { data: broadcast } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*), whatsapp_broadcast_recipients(*, contacts(name, phone, wa_phone))')
    .eq('id', id)
    .single()

  // IDOR guard — a broadcast (and its recipients' names/numbers) must belong to
  // a location the user can access. 404 (not 403) so foreign ids aren't
  // enumerable.
  if (!broadcast || assertLocationAccess(user, broadcast.location_id)) notFound()

  const { data: templates } = await db.from('whatsapp_templates')
    .select('*')
    .eq('location_id', user.activeLocation?.id)
    .eq('status', 'APPROVED')
    .order('name')

  // Failed recipients — fetched separately (the embed above is capped at 1000
  // rows for a large drip). Name · number · failure reason, newest first.
  const { data: failedRecipients } = await db.from('whatsapp_broadcast_recipients')
    .select('id, error_message, failed_at, contacts(name, wa_phone, phone)')
    .eq('broadcast_id', id)
    .eq('status', 'failed')
    .order('failed_at', { ascending: false })
    .limit(200)

  // COMMS-DETAIL-FIX.1 — the live recipient-row counts, for EVERY broadcast,
  // not just a drip. They were computed for an in-flight drip only, while the
  // finished-broadcast cards read whatsapp_broadcasts.total_* — which is how
  // one screen came to show "FAILED 0" above "Failed sends (22)". Everything
  // the body renders (cards, drip panel, recipients tab count, the failed-box
  // header) now comes off this one object, so they cannot disagree.
  //
  // The status column PROGRESSES in place, so "sent" is counted as
  // sent|delivered|read and "delivered" as delivered|read — see
  // whatsapp-broadcast-stats.js. No migration: five count-only queries need no
  // aggregate rpc, and code that depended on an unapplied one would 500.
  const recipientStats = await loadWhatsappBroadcastRecipientStats(db, id)
  const stats = whatsappBroadcastDisplayStats(broadcast, recipientStats)

  // The drip panel additionally needs today's rolling-24h cap usage and the
  // send-window state; the counts themselves come from `stats` like everything
  // else.
  let dripProgress = null
  if (broadcast.delivery_mode === 'drip') {
    dripProgress = {
      sentToday: await countWhatsappSentToday(db, id),
      window: dripWindowStatus(new Date(), {
        start: broadcast.send_window_start, end: broadcast.send_window_end,
        tz: broadcast.send_window_tz, paused: !!broadcast.paused_at,
      }),
    }
  }

  return (
    <WABroadcastEditor
      broadcast={broadcast}
      templates={templates || []}
      locationId={user.activeLocation?.id}
      userId={user.id}
      failedRecipients={failedRecipients || []}
      stats={stats}
      dripProgress={dripProgress}
    />
  )
}

// ── Email ──────────────────────────────────────────────────────────
async function renderEmail(db, user, id, searchParams) {
  const { data: campaign } = await db.from('campaigns')
    .select('*')
    .eq('id', id)
    .single()

  // IDOR guard — campaign (and its recipients) must belong to a location the
  // user can access. 404 (not 403) so foreign ids aren't enumerable. Must run
  // BEFORE the draft/edit branch below, or a foreign draft would open in the
  // editor.
  if (!campaign || assertLocationAccess(user, campaign.location_id)) notFound()

  // CAMPAIGN.4 — drafts (and any URL with ?edit=1) open in the editor.
  //
  // CAMPHIST.1 — but ONLY while the campaign's content may still change.
  // `?edit=1` used to open the full editor on any status, including 'sent'.
  // That is not a cosmetic problem: CampaignEditor saves by writing the
  // `campaigns` row directly from the browser Supabase client, so the 409
  // guard on PUT /api/campaigns/[id] never runs and the mig 014 RLS policy
  // (FOR ALL, no status predicate) permits it. The campaign's recipients,
  // opens, clicks and monthly rollups then describe an email nobody was sent,
  // with no copy of the real one anywhere. Reuse goes through
  // POST /api/campaigns/[id]/duplicate instead.
  const editRequested = searchParams?.edit === '1' || searchParams?.edit === 'true'
  const isDraft = campaign.status === 'draft'

  if ((isDraft || editRequested) && isCampaignContentEditable(campaign.status)) {
    return (
      <CampaignEditor
        campaign={campaign}
        locationId={campaign.location_id || user.activeLocation?.id}
        userId={user.id}
      />
    )
  }

  const { data: recipients } = await db.from('campaign_recipients')
    .select('*, contacts(name, email)')
    .eq('campaign_id', id)
    .order('sent_at', { ascending: false })
    .limit(100)

  // REPORT-SOT.2 — the displayed figures come from campaign_recipients, not
  // from campaigns.total_*. The counters miss every send-time rejection (they
  // are counted from email_sends, which never gets a row for one). The rpc is
  // safe to call with this id: the IDOR guard above already resolved the
  // campaign through assertLocationAccess.
  const recipientStats = await loadCampaignRecipientStats(db, [id])

  // CAMPAIGN-AB — per-variant sends/opens for the A/B panel (mig 398).
  let abStats = null
  if (campaign.ab_subject_b) {
    const { data } = await db.rpc('campaign_ab_variant_stats', { p_campaign_id: id })
    abStats = data || []
  }

  // CAMPAIGN-RESEND (mig 506) — parent/child linkage for the banner and the
  // "Resend of …" header line. At most one child (partial unique idx).
  const { data: resendChild } = await db.from('campaigns')
    .select('id, name, status')
    .eq('parent_campaign_id', id)
    .maybeSingle()
  let resendParent = null
  if (campaign.parent_campaign_id) {
    const { data } = await db.from('campaigns')
      .select('id, name')
      .eq('id', campaign.parent_campaign_id)
      .maybeSingle()
    resendParent = data
  }

  return (
    <CampaignDetail
      campaign={campaign}
      recipients={recipients || []}
      stats={campaignDisplayStats(campaign, recipientStats)}
      abStats={abStats}
      resendChild={resendChild}
      resendParent={resendParent}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
