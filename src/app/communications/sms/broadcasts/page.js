// PILLAR2 Phase 1 (1b) — RETIRED. The per-channel broadcast lists fold into the
// unified "Sent" history (/communications/sent). Kept as a redirect so old
// links/bookmarks resolve. Existing SMS broadcasts are still viewable at their
// detail route (/communications/sent/sms/[id]). Revert to restore the list.
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function SmsBroadcastsListRedirect() {
  redirect('/communications/sent')
}
