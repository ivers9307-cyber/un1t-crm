// /welcome/[location] — the old address of a studio page. PAGES.1: the studio
// pages are landing_pages rows (kind='studio') served at /<slug> by the one
// [slug] route (src/app/(public)/[slug]/[[...rest]]/page.js), so an old link,
// a bookmark or a checkout return still pointing here is sent on to
// /<location> with its query string as it came (utm_*, ?purchase=, ?edit=1).
// Anything that is not a slug 404s rather than redirect anywhere.

import { notFound, redirect } from 'next/navigation'
import { legacyStudioRedirect } from '@/lib/landing-page-render'

export const dynamic = 'force-dynamic'

export default async function LegacyStudioPage(props) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const target = legacyStudioRedirect(params?.location, null, searchParams)
  if (!target) notFound()
  redirect(target)
}
