// /book/manage/[token] — BOOKINGSELF.1: the person who booked cancels or
// reschedules their own booking, from the {{manage_url}} link in their
// booking confirmation and reminder emails.
//
// Public page: no session. A STATIC segment under /book/, so Next resolves it
// before /book/[slug] (and 'manage' is a reserved booking-type slug,
// src/lib/event-type-slug.js). /book/ is public on all FOUR allowlists, and
// /book/manage/ is listed on its own in each (proxy, AppShell, brands,
// tenant-domains-edge; src/public-compliance-paths.test.jsx) so narrowing
// /book/ can never take it down. The token in the path is the only
// credential and is checked by the /api/public/booking-manage/[token] routes
// the client component calls; nothing is read here.

import { headers } from 'next/headers'
import { customerFacingMetadata } from '@/lib/default-site-name'
import BookingManagePage from '@/components/BookingManagePage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The gym's name in the title (as /book/[slug]'s layout does); a personal
// link: never index it, never leak it as a referrer.
export async function generateMetadata() {
  const brand = await customerFacingMetadata({ host: (await headers()).get('host') })
  return { ...brand, robots: { index: false, follow: false }, referrer: 'no-referrer' }
}

export default async function Page(props) {
  const params = await props.params
  return (
    <div className="min-h-screen bg-white text-gray-900 flex items-start justify-center p-4 md:p-8">
      <BookingManagePage token={params.token} />
    </div>
  )
}
