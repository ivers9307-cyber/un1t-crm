// /communications layout — header + sub-nav (up to 6 tabs, permission-dependent).
//
// Phase 1 of the Email + WhatsApp merge. Visible to anyone with
// either the `email` or `whatsapp` permission; the individual
// sub-tabs gate themselves further (Inbox needs whatsapp,
// Campaigns needs email, etc.).
//
// hasPermission() honours the location feature gate (mig 032), so
// disabling either feature at a location's settings hides the
// matching sub-tab automatically.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import CommunicationsTabs from '@/components/communications/CommunicationsTabs'
import CommsShell from '@/components/communications/CommsShell'

export const dynamic = 'force-dynamic'

export default async function CommunicationsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  // EMAIL-TICKET.4 — the ticket inbox lives at /communications/tickets and is
  // gated on `email_inbox`, a DIFFERENT key from the marketing `email` one.
  // Without it in this OR, someone granted only the ticket surface gets
  // bounced off their own page by this layout before it ever renders.
  const canEmailInbox = hasPermission(user, 'email_inbox')
  if (!canEmail && !canWhatsapp && !canSms && !canEmailInbox) redirect('/')

  // COMMSLAYOUT.3 — the Segments tab's gate, computed here so it is the SAME
  // expression /communications/segments applies to itself. The page is
  // manager-only and both of its data sources agree (GET /api/segments is
  // "Manager+ required"), so the page gate is the correct one and the tab was
  // the side that was wrong: it rendered on `canEmail || canWhatsapp`, which a
  // `staff` user can hold, and clicking it redirected them to `/` — losing the
  // Communications context. Channel permission AND manager role, or no tab.
  const canSegments = (canEmail || canWhatsapp) && MANAGER_ROLES.includes(user.role)

  return (
    <CommsShell>
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Communications</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        {[
          (canEmail || canEmailInbox) && 'email',
          canWhatsapp && 'WhatsApp',
          canSms && 'SMS',
        ].filter(Boolean).join(' + ')} for {user.activeLocation?.name || 'your studio'}
      </p>
      <CommunicationsTabs
        canSms={canSms}
        canEmail={canEmail}
        canWhatsapp={canWhatsapp}
        canEmailInbox={canEmailInbox}
        canSegments={canSegments}
      />
      {children}
    </CommsShell>
  )
}
