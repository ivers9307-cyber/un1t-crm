// PILLAR2 Phase 1 (1b) — RETIRED. The per-channel broadcast lists fold into the
// unified "Sent" history (/communications/sent). Kept as a redirect so old
// links/bookmarks resolve. Existing WhatsApp broadcasts are still viewable at
// their detail route (/communications/sent/whatsapp/[id]). Revert to restore the list.
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function WaBroadcastsListRedirect() {
  redirect('/communications/sent')
}
