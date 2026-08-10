// COMMS-IA.1 — RETIRED. The WhatsApp broadcast detail moved into the
// consolidated send-detail route, /communications/sent/whatsapp/[id]. It used
// to render bare, outside the Communications shell; it now sits under the list
// it is opened from and shares that chrome.
//
// Kept as a redirect stub (same mechanism as the retired /whatsapp hub) so
// bookmarked broadcast URLs keep resolving. No auth check here: this file reads
// nothing and renders nothing, and the destination carries the gate (the
// /communications layout auth redirect, the `whatsapp` permission check, and
// the location IDOR guard that 404s a foreign broadcast).

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function WaBroadcastDetailRedirect(props) {
  const params = await props.params
  redirect(`/communications/sent/whatsapp/${params.id}`)
}
