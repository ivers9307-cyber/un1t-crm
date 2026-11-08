import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import RaceSignupWidget from '@/components/RaceSignupWidget'
import { redirectTargetForSlug } from '@/lib/event-slug'
import { createServerClient } from '@/lib/supabase'
import { getLocationBranding } from '@/lib/location-branding'
import { resolveGymSiteName } from '@/lib/default-site-name'
import { poppinsBody as poppins } from '@/fonts/poppins'

// Brand font for this public surface. Loaded via next/font (self-hosted
// at build, zero external requests / layout shift) and exposed as the
// `--font-body` CSS variable that the `font-body` Tailwind family
// resolves to. Defining the variable on the page wrapper scopes Poppins
// to this subtree only — the CRM app keeps its default stack.

// Dynamic so wave / pricing edits in the operator UI surface to the
// public page on the next request — `force-static` (the previous
// setting) cached the rendered shell for 60s, which is why operators
// reported "I added a wave but it doesn't show up". The widget itself
// fetches /api/public/events/[slug] client-side anyway, so the page
// shell is essentially a thin React mount-point — no perf loss.
export const dynamic = 'force-dynamic'

// Per-event Open Graph metadata so WhatsApp / iMessage / email
// previews show the actual event name + description instead of the
// generic site default. Falls back to the site default on lookup
// failure (DB hiccup, slug typo) — never breaks the page.
//
// W1.L4 — the brand in the title / site name is the EVENT'S OWN location's
// (getLocationBranding: company_settings → org_settings → location name),
// never a literal; the host's organisation brand floors it when the
// location resolves nothing.
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
      .select('name, description, kind, location_id')
      .eq('slug', params.slug)
      .eq('active', true)
      .eq('status', 'published')
      // SINGLEERR.1 — maybeSingle, not single: race_events.slug carries a GLOBAL
      // unique index (mig 451), so this is 0-or-1 rows and 0 (no such event, or
      // unpublished) is a real answer rather than an error to discard.
      .maybeSingle()
    if (!data) return {}
    const brand = (await getLocationBranding(db, data.location_id)).companyName
      || await resolveGymSiteName({ host: (await headers()).get('host') })
    const title = `${data.name} — ${brand}`
    const desc = data.description
      ? (data.description.length > 200
          ? data.description.slice(0, 197).trim() + '…'
          : data.description)
      : `Sign up at ${brand}.`
    return {
      title,
      description: desc,
      openGraph: {
        title,
        description: desc,
        siteName: brand,
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
  // EVENT-SLUG.1 — a renamed event keeps its old slugs as aliases (mig 706):
  // /event/pride-training-club-4 (emailed to 164 people) sends the visitor
  // to /event/hatch-oct18-1230. Live slugs never redirect; a failed lookup
  // renders the page as before. redirect() throws by design — keep it
  // outside the helper's try/catch.
  const target = await redirectTargetForSlug(createServerClient(), params.slug)
  if (target) redirect(`/event/${target}`)
  return (
    <div className={`${poppins.variable} font-body min-h-screen bg-black text-white`}>
      <RaceSignupWidget slug={params.slug} />
    </div>
  )
}
