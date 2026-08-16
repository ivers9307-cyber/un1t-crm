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

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import CommunicationsTabs from '@/components/communications/CommunicationsTabs'
import CommsShell from '@/components/communications/CommsShell'

export const dynamic = 'force-dynamic'

export default async function CommunicationsHubLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login') // parent layout already gates; defensive for render-order edge cases

  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canEmailInbox = hasPermission(user, 'email_inbox')

  return (
    <CommsShell>
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Messages</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        {[
          canWhatsapp && 'WhatsApp',
          canEmailInbox && 'email inbox',
        ].filter(Boolean).join(' + ')} for {user.activeLocation?.name || 'your studio'}
      </p>
      <CommunicationsTabs
        canWhatsapp={canWhatsapp}
        canEmailInbox={canEmailInbox}
      />
      {children}
    </CommsShell>
  )
}
