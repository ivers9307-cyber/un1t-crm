// /communications layout — access gate only.
//
// The hub chrome (header + tab strip) lives in (hub)/layout.js so that
// full-screen surfaces — the template editors under (editors)/templates/
// email|whatsapp — share this gate without inheriting the chrome.
//
// GATES-2 — this is the COARSE gate: email, whatsapp or email_inbox at SOME
// studio (src/lib/communications-access.js). It decided at the ACTIVE studio,
// which bounced pages that judge a record's studio (sent/[channel]/[id], the
// template editors, Mail across studios) before they ran. Every page carries
// its own decision; the ones about the active studio keep this layout's old
// rule (canUseCommunicationsHere). The feature gate (mig 032) still applies
// per studio inside each permission check.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { canUseCommunicationsSomewhere } from '@/lib/communications-access'
import { staffTabMetadata } from '@/lib/staff-tab-title'

export const dynamic = 'force-dynamic'

// TABTITLE.1 — the tab names the ACTIVE studio for every page under this
// layout (see src/lib/staff-tab-title.js). This is the OUTERMOST staff layout
// of its subtree: a layout nested under it must NOT export this again, or the
// tab reads "Studio · Studio".
export async function generateMetadata() {
  return staffTabMetadata()
}

export default async function CommunicationsLayout({ children }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // EMAIL-TICKET.4 — `email_inbox` (Mail) is in the set, a DIFFERENT key
  // from the marketing `email` one.
  if (!canUseCommunicationsSomewhere(user)) redirect('/')

  return children
}
