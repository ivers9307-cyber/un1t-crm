// /communications layout — header + 5-segment sub-nav.
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
import CommunicationsTabs from '@/components/communications/CommunicationsTabs'
import CommsShell from '@/components/communications/CommsShell'

export const dynamic = 'force-dynamic'

export default async function CommunicationsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  if (!canEmail && !canWhatsapp && !canSms) redirect('/')

  return (
    <CommsShell>
      <h1 className="text-2xl font-bold text-un1t-text mb-1">Communications</h1>
      <p className="text-sm text-un1t-subtle mb-5">
        {[
          canEmail && 'email',
          canWhatsapp && 'WhatsApp',
          canSms && 'SMS',
        ].filter(Boolean).join(' + ')} for {user.activeLocation?.name || 'your studio'}
      </p>
      <CommunicationsTabs canSms={canSms} canEmail={canEmail} canWhatsapp={canWhatsapp} />
      {children}
    </CommsShell>
  )
}
