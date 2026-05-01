// Permanently redirect old /whatsapp hub to the merged
// /communications. Phase 1 of the email + WhatsApp merge. Sub-pages
// (/whatsapp/inbox, /whatsapp/broadcasts, /whatsapp/templates) keep
// working for now via their own redirect stubs.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function WhatsAppRedirect() {
  redirect('/communications')
}
