import RaceSignupWidget from '@/components/RaceSignupWidget'
import { createServerClient } from '@/lib/supabase'

// Dynamic so wave / pricing edits in the operator UI surface to the
// public page on the next request — `force-static` (the previous
// setting) cached the rendered shell for 60s, which is why operators
// reported "I added a wave but it doesn't show up". The widget itself
// fetches /api/public/events/[slug] client-side anyway, so the page
// shell is essentially a thin React mount-point — no perf loss.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Per-event Open Graph metadata so WhatsApp / iMessage / email
// previews show the actual event name + description instead of the
// generic site default ("UN1T Dublin — strength, conditioning,
// racing"). Falls back to the site default on lookup failure (DB
// hiccup, slug typo) — never breaks the page.
//
// Description is truncated at 200 chars because OG description
// has practical platform limits (Twitter cards cap around 200,
// some preview generators truncate even shorter). Keeps the
// preview readable rather than truncating mid-bullet.
export async function generateMetadata(props) {
  const params = await props.params;
  try {
    const db = createServerClient()
    const { data } = await db
      .from('race_events')
      .select('name, description, kind')
      .eq('slug', params.slug)
      .eq('active', true)
      .single()
    if (!data) return {}
    const title = `${data.name} — UN1T Dublin`
    const desc = data.description
      ? (data.description.length > 200
          ? data.description.slice(0, 197).trim() + '…'
          : data.description)
      : 'Sign up at UN1T Dublin.'
    return {
      title,
      description: desc,
      openGraph: {
        title,
        description: desc,
        siteName: 'UN1T Dublin',
        type: 'website',
      },
    }
  } catch {
    // Lookup failed — let the root layout's defaults apply.
    return {}
  }
}

export default async function PublicRaceSignupPage(props) {
  const params = await props.params;
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <RaceSignupWidget slug={params.slug} />
    </div>
  )
}
