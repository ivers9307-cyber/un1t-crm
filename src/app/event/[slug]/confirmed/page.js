// /event/[slug]/confirmed — post-payment success page (mig 084).
//
// Public page. Buyer arrives here after the embedded checkout's
// onSuccess fires (or after the Revolut redirect_url falls through).
// Loads the race + registration via the existing public race
// endpoint + a small registration-specific lookup.
//
// W1.L5: the server resolves the TENANT's identity for the calendar file
// (brand name via getLocationBranding, hostname via resolveCustomerBaseUrl —
// <org.slug>.repset.ie or the custom domain) and hands it to the client
// component, so the .ics never carries the platform's first gym. The lookup
// never throws (resolveEventIcsIdentity has neutral floors): a buyer who
// just paid always gets this page.

import { poppinsBody as poppins } from '@/fonts/poppins'
import RaceConfirmedPage from '@/components/RaceConfirmedPage'
import { createServerClient } from '@/lib/supabase'
import { resolveEventIcsIdentity } from '@/lib/event-ics'

export const runtime = 'nodejs'

export default async function Page(props) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const { brandName, hostname } = await resolveEventIcsIdentity(createServerClient(), params.slug)
  return (
    <div className={`${poppins.variable} font-body`}>
      <RaceConfirmedPage
        slug={params.slug}
        registrationId={searchParams?.registration || null}
        brandName={brandName}
        hostname={hostname}
      />
    </div>
  )
}
