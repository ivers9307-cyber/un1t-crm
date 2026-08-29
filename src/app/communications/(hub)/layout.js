// /communications (hub) layout — header + sub-nav for the Messages
// landing: the unified WhatsApp/Instagram inbox + the email support-ticket
// queue + this index page. Access is already gated by the parent
// communications/layout.js; the permission booleans are recomputed here
// because the chrome needs them for tab visibility — deliberate
// duplication, the gate and the chrome are separate jobs.
//
// DEEP.4 Task 2 (4B) — Send/Sent/Templates/Segments/List health moved OUT
// of this group into communications/(marketing-era), a sibling route
// group with its own chrome (URLs unchanged — see that layout's header
// comment for the full mechanism). This layout — and CommunicationsTabs —
// now cover only the two surfaces that are genuinely Messages territory.
// The Segments manager-role gate (COMMSLAYOUT.3) moved with the Segments
// tab; `canSegments`/`canEmail`/`canSms` are no longer computed here.
//
// INBOX-SURFACE.C — THE MAIL TAB IS DATA-GATED, NOT PERMISSION-GATED.
// /communications/mail is the email surface (the only one, since
// RETIRE-TICKETS.1): the tab shows wherever the studio has an active email
// account, and a studio with none has NOTHING for it to show, so the tab does
// not appear — an empty surface in the nav is worse than no surface, because
// the operator clicks it, finds a blank page, and concludes their mail is
// missing.
//
// That means one small extra read per hub render, and it is done HERE rather
// than in the client strip because the answer has to be present on first paint:
// a tab that pops in after a fetch is a tab that shifts the row under a cursor
// already moving towards it.
//
// 🔴 IT FAILS TO TAB-HIDDEN. An unreadable answer — a blipped query — hides
// the Mail tab and leaves everything else exactly as it was. That is the safe
// direction: showing the tab on a guess risks the empty surface this gate
// exists to prevent, while hiding it costs a URL that still works if typed,
// and nothing about a studio's mail changes either way. It is deliberately NOT
// treated as an error the way a mailbox-visibility failure is on the mail
// routes — this is chrome, and a blank hub is a worse answer than a missing tab.
//
// DEEP.4 final review — Messages' entry gate is the wider (canEmail ||
// canWhatsapp || canSms) union (nav-items.js), which is broader than the
// two keys this layout now cares about, so an email-only or sms-only
// user reaches here holding NEITHER canWhatsapp nor canEmailInbox. That
// used to leave an orphaned " for <location>" subtitle (no channel word
// before it) and CommunicationsTabs rendering its outer strip box with
// zero tabs inside. Fixed with a channel-word fallback below and a
// >0 guard around <CommunicationsTabs> — mirrors HubTabs' own
// hide-when-empty behaviour elsewhere in the app.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import CommunicationsTabs from '@/components/communications/CommunicationsTabs'
import CommsShell from '@/components/communications/CommsShell'

export const dynamic = 'force-dynamic'

export default async function CommunicationsHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login') // parent layout already gates; defensive for render-order edge cases

  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canEmailInbox = hasPermission(user, 'email_inbox')

  // INBOX-SURFACE.C / RETIRE-TICKETS.1 — still data-gated, but the question
  // simplified with the surface split's retirement (mig 578): "does this
  // studio have any ACTIVE email account at all". Scoped to the ACTIVE
  // location, the only studio this hub ever shows; `active` because a
  // deactivated account is hidden from every inbox. An empty tab in the nav
  // is worse than no tab — the operator clicks it, finds a blank page, and
  // concludes email is broken.
  const canMail = canEmailInbox && await locationHasMailbox(user.activeLocation?.id)

  // DEEP.4 final review — fallback keeps the subtitle from reading as
  // "for <location>" with no channel word when neither key is held.
  const channelWords = [
    canWhatsapp && 'WhatsApp',
    canEmailInbox && 'email',
  ].filter(Boolean).join(' + ') || 'messages'

  return (
    <CommsShell>
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Messages</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        {channelWords} for {user.activeLocation?.name || 'your studio'}
      </p>
      {/* DEEP.4 final review — an email-only or sms-only user holds neither
          tab's permission; without this guard CommunicationsTabs still
          rendered its outer strip box, empty. */}
      {(canWhatsapp || canEmailInbox) && (
        <CommunicationsTabs
          canWhatsapp={canWhatsapp}
          canMail={canMail}
        />
      )}
      {children}
    </CommsShell>
  )
}

/**
 * Does this studio have at least one ACTIVE email account?
 *
 * Service-role read, scoped by location_id in the query itself — this is a
 * layout, so RLS does nothing for it, exactly as on an /api route. It reads no
 * credential and no address: one boolean column and a location filter.
 * (RETIRE-TICKETS.1 dropped the `.eq('surface', …)` half — mig 578 retired
 * the column and nothing reads it.)
 *
 * Never throws and never surfaces an error. False on anything unexpected —
 * hiding the tab is the safe direction.
 */
async function locationHasMailbox(locationId) {
  if (!locationId) return false
  try {
    const db = createServerClient()
    const { data, error } = await db.from('email_mailboxes')
      .select('id')
      .eq('location_id', locationId)
      .eq('active', true)
      .limit(1)
    if (error) return false
    return (data || []).length > 0
  } catch {
    // A supabase builder RESOLVES rather than throws, so this catch is for the
    // client construction itself (a missing env in a preview, say). Same
    // answer either way.
    return false
  }
}
