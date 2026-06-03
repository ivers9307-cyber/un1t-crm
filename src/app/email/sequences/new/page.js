import { redirect } from 'next/navigation'

// FLOW-GRAPH Phase 2 (PR3c-6) — the classic sequence editor is retired. The
// "New sequence" flow now lives in the visual builder (NewSequenceButton on the
// list creates a draft and opens /communications/sequences/[id]). This legacy
// path just bounces to the list so old bookmarks keep working.
export const dynamic = 'force-dynamic'

export default function LegacyNewSequenceRedirect() {
  redirect('/communications/sequences')
}
