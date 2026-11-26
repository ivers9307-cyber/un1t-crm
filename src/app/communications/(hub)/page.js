// /communications — landing/hub.
//
// Combined snapshot of email and WhatsApp activity for the
// current location (SMS was retired with Twilio, TWILIO-RETIRE.1).
// Stats only show for channels the user has permission for.
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
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canUseCommunicationsHere } from '@/lib/communications-access'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { tierLabel, qualityAccent } from '@/lib/whatsapp-number-health'
import { loadWhatsAppHubHealth } from './wa-hub-health.js'
import { Mail, MessageCircle, Inbox, ShieldCheck, Gauge } from 'lucide-react'

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
  if (!user) redirect('/login')
  // GATES-2 — the hub is about the ACTIVE studio; the layout is only the
  // coarse gate now, so this keeps the layout's old rule here.
  if (!canUseCommunicationsHere(user)) redirect('/')
  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  // EMAIL-TICKET.4 key — the studio email surface, not the marketing `email`
  // one. Powers the Mail card below.
  const canEmailInbox = hasPermission(user, 'email_inbox')

  const db = createServerClient()
  const locationId = user.activeLocation?.id

  // SPLITNAV.1 — Messages is for conversations; campaign stats live under
  // Marketing (Sent, List health), so they are not loaded here any more.

  // WhatsApp stats
  let unreadConvos = 0, waHealth = null
  if (canWhatsapp && locationId) {
    // Number health (Meta quality rating + messaging tier) — stored by the
    // refresh-whatsapp-health cron (mig 329). The studio's default switched-on
    // number (WAORGNUMBER.1; wa-hub-health.js).
    waHealth = await loadWhatsAppHubHealth(locationId)

    // Unread = conversations with unread inbound messages.
    const { count: unread } = await db
      .from('whatsapp_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .gt('unread_count', 0)
    unreadConvos = unread || 0

  }

  return (
    <div>
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
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
      </div>

      {/* SPLITNAV.1 — one way into the marketing side from here, not five
          duplicate cards: Messages is conversations, Marketing is sends. */}
      {(canEmail || canWhatsapp) && (
        <p className="mt-6 text-sm text-un1t-subtle">
          Campaigns, automations, templates and list health are under{' '}
          <Link href="/communications/send" className="underline text-un1t-text">Marketing</Link>.
        </p>
      )}
    </div>
  )
}
