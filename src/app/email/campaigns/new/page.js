// COMMS-IA.2 — DELETED. This route rendered a SECOND full CampaignEditor
// (audience + Unlayer + settings) that nothing in src/ linked to: the segment
// deep-link PILLAR2 kept it for now goes to /communications/send, and every
// other compose entry point already did. Two divergent compose surfaces to keep
// correct forever, one of which no operator could reach.
//
// The component itself is NOT deleted — CampaignEditor is still the draft/edit
// body of /communications/sent/email/[id] (drafts and ?edit=1 open in it, and
// UnifiedSendComposer hands off to it for email).
//
// Redirects to the primary composer rather than 404ing, in case it is
// bookmarked. No auth check here: the destination is gated.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function NewCampaignRedirect() {
  redirect('/communications/send')
}
