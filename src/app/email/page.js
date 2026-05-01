// Permanently redirect old /email hub to the merged /communications.
// Phase 1 of the email + WhatsApp merge. Detail pages
// (/email/campaigns/[id], /email/sequences/[id], /email/templates/*)
// stay where they are for now and continue to work.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function EmailRedirect() {
  redirect('/communications')
}
