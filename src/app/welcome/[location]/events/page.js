// /welcome/[location]/events — the old address of a studio's events listing.
// PAGES.1: it is /<slug>/events on the one [slug] route now
// (StudioEventsPage); an old link is sent on with its query string kept.

import { notFound, redirect } from 'next/navigation'
import { legacyStudioRedirect } from '@/lib/landing-page-render'

export const dynamic = 'force-dynamic'

export default async function LegacyStudioEventsPage(props) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const target = legacyStudioRedirect(params?.location, 'events', searchParams)
  if (!target) notFound()
  redirect(target)
}
