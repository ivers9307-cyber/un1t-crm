import BookingWidget from '@/components/BookingWidget'

// This page is publicly accessible — no auth required and no server
// data fetch. Letting Next.js statically render the shell means
// Vercel can serve a CDN-cached HTML stub instead of running a full
// server render on every load — much faster first paint.
//
// All booking state lives in BookingWidget (a client component) which
// fetches the event details from /api/public/events/[slug] at mount.
export const dynamicParams = true
export const revalidate = 3600

// It can also be embedded as an iframe on your website
export default function PublicBookingPage({ params }) {
  return <BookingWidget slug={params.slug} />
}
