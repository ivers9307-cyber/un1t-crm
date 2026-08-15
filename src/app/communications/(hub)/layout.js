// /communications (hub) layout — header + sub-nav (up to 6 tabs,
// permission-dependent). Access is already gated by the parent
// communications/layout.js; the permission booleans are recomputed
// here because the chrome needs them for tab visibility — deliberate
// duplication, the gate and the chrome are separate jobs.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import CommunicationsTabs from '@/components/communications/CommunicationsTabs'
import CommsShell from '@/components/communications/CommsShell'

export const dynamic = 'force-dynamic'

export default async function CommunicationsHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login') // parent layout already gates; defensive for render-order edge cases

  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  const canEmailInbox = hasPermission(user, 'email_inbox')

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
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Messages</h1>
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
