// COMMS-IA.1 — RETIRED. The email campaign detail/editor moved into the
// consolidated send-detail route, /communications/sent/email/[id], so all three
// channels share one chrome under the list they were opened from.
//
// Kept as a redirect stub — the same mechanism the retired hubs (/email,
// /whatsapp) and lists (/communications/campaigns, /communications/broadcasts)
// already use — because these are live URLs: operators bookmark them and
// campaign notification email links straight at them. `?edit=1` is carried
// across so a bookmarked draft still opens in the editor.
//
// No auth check here on purpose: this file reads nothing and renders nothing,
// and the destination carries the gate (the /communications layout's auth
// redirect, the `email` permission check, and the location IDOR guard).

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function CampaignDetailRedirect(props) {
  const params = await props.params
  const searchParams = (await props.searchParams) || {}
  const edit = searchParams.edit === '1' || searchParams.edit === 'true'
  redirect(`/communications/sent/email/${params.id}${edit ? '?edit=1' : ''}`)
}
