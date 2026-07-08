// /embed/event/[slug] — bare, iframe-embeddable event signup.
//
// The paste-anywhere external embed: an operator drops
//   <iframe src="https://un1tdublin.com/embed/event/<slug>"> ...
// into any website and gets the full signup form for that event, with
// no site chrome (no nav/footer) so it sits cleanly inside a host page.
//
// embedded={true} tells RaceSignupWidget to break post-submit
// navigation (confirmation / payment) OUT to the top window, so the
// flow doesn't get trapped inside the host's iframe.
//
// No X-Frame-Options / frame-ancestors are set app-wide, so this route
// is framable by default — which is the whole point here.

import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import RaceSignupWidget from '@/components/RaceSignupWidget'

export const dynamic = 'force-dynamic'

export async function generateMetadata(props) {
  const params = await props.params
  try {
    const db = createServerClient()
    const { data } = await db
      .from('race_events')
      .select('name')
      .eq('slug', params.slug)
      .eq('active', true)
      .eq('status', 'published')
      .single()
    const title = data?.name ? `${data.name} — Sign up` : 'UN1T Dublin — Sign up'
    // Embeds shouldn't be indexed as standalone pages; the canonical
    // signup lives at /event/<slug>.
    return { title, robots: { index: false, follow: false } }
  } catch {
    return { title: 'UN1T Dublin — Sign up', robots: { index: false, follow: false } }
  }
}

export default async function EventEmbedPage(props) {
  const params = await props.params
  const db = createServerClient()
  const { data: ev } = await db
    .from('race_events')
    .select('id')
    .eq('slug', params.slug)
    .eq('active', true)
    .eq('status', 'published')
    .single()
  if (!ev) notFound()

  return (
    <div className="bg-transparent p-3">
      <RaceSignupWidget slug={params.slug} embedded />
    </div>
  )
}
