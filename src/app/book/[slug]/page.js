import BookingWidget from '@/components/BookingWidget'

export const dynamic = 'force-dynamic'

// This page is publicly accessible — no auth required
// It can also be embedded as an iframe on your website
export default function PublicBookingPage({ params }) {
  return <BookingWidget slug={params.slug} />
}
