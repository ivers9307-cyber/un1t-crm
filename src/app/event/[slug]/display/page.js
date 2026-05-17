// /race/[slug]/display
//
// TV-friendly race-day board. Public — no auth, designed for an
// always-on studio TV. Auto-rotates between two screens (active on
// course / completed for the day) every 20s, polls for fresh state
// every 2s. Lives at this URL pattern for symmetry with the public
// signup page at /race/[slug] — staff just append /display to the
// existing share link.
//
// Pure mount-point. The actual board lives in a client component
// because of the polling + rotation timers + live elapsed clock.

import RaceDisplayBoard from '@/components/RaceDisplayBoard'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function RaceDisplayPage(props) {
  const params = await props.params;
  return <RaceDisplayBoard slug={params.slug} />
}
