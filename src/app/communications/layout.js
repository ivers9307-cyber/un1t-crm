// /communications layout — access gate only.
//
// The hub chrome (header + tab strip) lives in (hub)/layout.js so that
// full-screen surfaces — the template editors under (editors)/templates/
// email|whatsapp — share this gate without inheriting the chrome.
//
// hasPermission() honours the location feature gate (mig 032), so
// disabling a channel at a location's settings closes the whole tree.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function CommunicationsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canEmail = hasPermission(user, 'email')
  const canWhatsapp = hasPermission(user, 'whatsapp')
  const canSms = hasPermission(user, 'sms')
  // EMAIL-TICKET.4 — the email surface lives at /communications/mail and is
  // gated on `email_inbox`, a DIFFERENT key from the marketing `email` one.
  // Without it in this OR, someone granted only the ticket surface gets
  // bounced off their own page by this layout before it ever renders.
  const canEmailInbox = hasPermission(user, 'email_inbox')
  if (!canEmail && !canWhatsapp && !canSms && !canEmailInbox) redirect('/')

  return children
}
