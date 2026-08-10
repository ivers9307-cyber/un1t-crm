// PILLAR2 Phase 2 (2b) — RETIRED. The email campaigns list folds into the unified
// "Sent" history (/communications/sent). Kept as a redirect so old links/bookmarks
// resolve. Composing an email is now /communications/send (Email channel); existing
// campaigns are still viewable/editable at /communications/sent/email/[id]. Revert to restore.
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function CampaignsListRedirect() {
  redirect('/communications/sent')
}
