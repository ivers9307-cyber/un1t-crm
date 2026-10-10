import { headers } from 'next/headers'
import PreferenceCentre from '@/components/PreferenceCentre'
import { resolveGymSiteName } from '@/lib/default-site-name'

// Public, no auth, no server data fetch for the body — PreferenceCentre
// hydrates client-side. W1.L4: the title resolves by the request host,
// which is a dynamic read, so the former static shell (`revalidate = 3600`)
// is now rendered per request.
export const dynamic = 'force-dynamic'

// W1.L4 — the tab names the request host's organisation brand, never a
// literal.
export async function generateMetadata() {
  const brand = await resolveGymSiteName({ host: (await headers()).get('host') })
  return { title: `Communication Preferences — ${brand}` }
}

export default async function PreferencePage(props) {
  const params = await props.params;
  return <PreferenceCentre token={params.token} />
}
