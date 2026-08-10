// COMMS-IA.1 — RETIRED. The SMS broadcast detail moved into the consolidated
// send-detail route, /communications/sent/sms/[id], alongside the WhatsApp and
// email siblings.
//
// Kept as a redirect stub (same mechanism as the retired
// /communications/sms/broadcasts list next to it) so bookmarked broadcast URLs
// keep resolving. This stub still sits under the /communications layout, so it
// keeps that layout's auth gate on the way through; the destination re-applies
// it along with the `sms` permission check and the location IDOR guard.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function SmsBroadcastDetailRedirect(props) {
  const params = await props.params
  redirect(`/communications/sent/sms/${params.id}`)
}
