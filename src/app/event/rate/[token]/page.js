// /event/rate/[token] — HOSTPAGE.2: an attendee rates a host's event from the
// "How was <event>?" email sent the morning after.
//
// Public page: no session. It lives under /event/ (outside every auth-gated
// segment, on all four public-path allowlists as a directory). The token in
// the path is the only credential and is checked by the
// /api/public/event-rating/[token] routes the client component calls;
// nothing is read here.

import { poppinsBody as poppins } from '@/fonts/poppins'
import EventRatingPage from '@/components/EventRatingPage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A personal link: never index it, never leak it as a referrer.
export const metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function Page(props) {
  const params = await props.params
  return (
    <div className={`${poppins.variable} font-body min-h-screen bg-black text-white`}>
      <EventRatingPage token={params.token} />
    </div>
  )
}
