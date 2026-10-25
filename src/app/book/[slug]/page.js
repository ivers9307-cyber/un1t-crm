import BookingWidget from '@/components/BookingWidget'

// This page is publicly accessible — no auth required and no server
// data fetch of its own. All booking state lives in BookingWidget (a
// client component) which fetches the event details from
// /api/public/events/[slug] at mount.
//
// Rendered per request since W1.L4: this subtree's layout and the root
// layout read the Host header to brand the <title> (a dynamic API), so the
// former `revalidate = 3600` CDN-cached shell no longer applied. The render
// is a thin React mount-point, so the cost is a lambda hit, not a query.
export const dynamic = 'force-dynamic'

// It can also be embedded as an iframe on your website
export default async function PublicBookingPage(props) {
  const params = await props.params;
  return <BookingWidget slug={params.slug} />
}
