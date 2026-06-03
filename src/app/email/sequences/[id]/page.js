import { redirect } from 'next/navigation'

// FLOW-GRAPH Phase 2 (PR3c-6) — the classic sequence editor is retired; the
// visual builder at /communications/sequences/[id] is the one editor. This
// legacy path permanently bounces there so old bookmarks keep working.
export const dynamic = 'force-dynamic'

export default async function LegacySequenceRedirect(props) {
  const params = await props.params
  redirect(`/communications/sequences/${params.id}`)
}
