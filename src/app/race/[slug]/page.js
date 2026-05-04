import RaceSignupWidget from '@/components/RaceSignupWidget'

// Dynamic so wave / pricing edits in the operator UI surface to the
// public page on the next request — `force-static` (the previous
// setting) cached the rendered shell for 60s, which is why operators
// reported "I added a wave but it doesn't show up". The widget itself
// fetches /api/public/races/[slug] client-side anyway, so the page
// shell is essentially a thin React mount-point — no perf loss.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function PublicRaceSignupPage({ params }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <RaceSignupWidget slug={params.slug} />
    </div>
  )
}
