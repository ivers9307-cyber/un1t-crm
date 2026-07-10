// GET /h/[slug] — public mailing-list signup page for an event host
// (HOST-EMAIL.2). Lives OUTSIDE the auth-gated segments and is allowlisted
// in src/proxy.js publicPaths, AppShell PUBLIC_PATHS, and the un1t-hosts
// brand allowedPaths (src/lib/brands.js) — all three, same as /event/.
//
// Server component: host by slug via the service client (notFound when the
// slug is unknown — slugs are public, no enumeration concern), then the
// dark host-branded signup form hydrates client-side and POSTs to
// /api/public/host-list/[slug]/subscribe.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import HostListSignup from '@/components/HostListSignup'
import { Poppins } from 'next/font/google'

// Same brand-font setup as /event/[slug] — self-hosted Poppins scoped to
// this public subtree via the `--font-body` variable.
const poppins = Poppins({
  weight: ['400', '500', '600', '700', '800'],
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export const dynamic = 'force-dynamic'

export async function generateMetadata(props) {
  const params = await props.params
  try {
    const db = createServerClient()
    const { data } = await db
      .from('event_hosts')
      .select('name')
      .eq('slug', params.slug)
      .maybeSingle()
    if (!data) return {}
    return {
      title: `${data.name} — mailing list`,
      description: `Get emails about ${data.name}'s events. Unsubscribe anytime.`,
    }
  } catch {
    return {}
  }
}

export default async function HostMailingListPage(props) {
  const params = await props.params
  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, slug')
    .eq('slug', params.slug)
    .maybeSingle()
  if (!host) notFound()

  return (
    <div className={`${poppins.variable} font-body flex min-h-screen items-center justify-center bg-black px-4 py-16 text-white`}>
      <HostListSignup slug={host.slug} hostName={host.name} />
    </div>
  )
}
