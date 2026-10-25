// INTEGONE.3 — the organisation's WhatsApp numbers are the Integrations hub's
// `whatsapp-numbers` drawer (opened from the WhatsApp card's "Organisation
// numbers" button), which holds the organisation-admin gate. This URL stays so
// every bookmark and old link lands there. A signed-out caller still goes to
// /login first.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { ORG_NUMBERS_PAGE } from '@/lib/org-whatsapp-numbers-page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function WhatsAppNumbersPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(ORG_NUMBERS_PAGE)
}
