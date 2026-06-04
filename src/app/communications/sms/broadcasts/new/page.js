// PILLAR2 Phase 1 (1b) — RETIRED. The unified send surface
// (/communications/send) replaces the per-channel composers. Kept as a redirect
// so old links/bookmarks resolve. Revert this file to restore the standalone
// "new SMS broadcast" composer (SMSBroadcastEditor is still used by the [id] page).
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function NewSmsBroadcastRedirect() {
  redirect('/communications/send')
}
