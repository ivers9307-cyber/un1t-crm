// /welcome/[location]/status — the old address of a studio's public status
// page (STATUS-PAGE.1). PAGES.1: it is /<slug>/status on the one [slug] route
// now (StudioStatusPage, with its 60 s health cache); an old link is sent on
// with its query string kept.

import { notFound, redirect } from 'next/navigation'
import { legacyStudioRedirect } from '@/lib/landing-page-render'

export const dynamic = 'force-dynamic'

export default async function LegacyStudioStatusPage(props) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams])
  const target = legacyStudioRedirect(params?.location, 'status', searchParams)
  if (!target) notFound()
  redirect(target)
}
