// /race/[slug]/confirmed — post-payment success page (mig 084).
//
// Public page. Buyer arrives here after the embedded checkout's
// onSuccess fires (or after the Revolut redirect_url falls through).
// Loads the race + registration via the existing public race
// endpoint + a small registration-specific lookup.

import RaceConfirmedPage from '@/components/RaceConfirmedPage'

export const runtime = 'nodejs'

export default async function Page(props) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  return (
    <RaceConfirmedPage
      slug={params.slug}
      registrationId={searchParams?.registration || null}
    />
  )
}
