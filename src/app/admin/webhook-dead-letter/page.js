// /admin/webhook-dead-letter — triage surface for webhook_dead_letter
// (DEADLETTER-UI.1). The table existed since mig 315 and the JSON API since
// POSTMARK-DLQ.1, but nothing consumed it: rows carrying GDPR one-click
// unsubscribes, unroutable inbound mail and sent-but-unfiled ticket email sat
// invisible unless someone curled the API. This page is the missing consumer.
//
// Master-or-owner at the page level (mirrors the /api/admin/webhook-dead-letter
// auth check exactly — the /admin layout's relaxed gate is not enough here).
// Surfacing only: every action is an explicit human decision; nothing here
// processes payloads.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import WebhookDeadLetterTable from '@/components/WebhookDeadLetterTable'

export const dynamic = 'force-dynamic'

export default async function WebhookDeadLetterPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.profileRole !== 'master' && user.role !== 'owner') redirect('/')

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Webhook dead letters</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-2xl">
        Events a provider delivered that we could not process — unroutable or unparseable inbound email,
        delivery events (bounces, spam complaints, one-click unsubscribes) that ran out of retries, and
        email that was sent but could not be filed on its ticket. Nothing retries these on its own:
        replay the few that are safely replayable, handle the rest by hand, then mark them resolved.
      </p>
      <WebhookDeadLetterTable />
    </div>
  )
}
