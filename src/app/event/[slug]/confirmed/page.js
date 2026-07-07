// /race/[slug]/confirmed — post-payment success page (mig 084).
//
// Public page. Buyer arrives here after the embedded checkout's
// onSuccess fires (or after the Revolut redirect_url falls through).
// Loads the race + registration via the existing public race
// endpoint + a small registration-specific lookup.

import { Poppins } from 'next/font/google'
import RaceConfirmedPage from '@/components/RaceConfirmedPage'

export const runtime = 'nodejs'

const poppins = Poppins({
  weight: ['400', '500', '600', '700', '800'],
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export default async function Page(props) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  return (
    <div className={`${poppins.variable} font-body`}>
      <RaceConfirmedPage
        slug={params.slug}
        registrationId={searchParams?.registration || null}
      />
    </div>
  )
}
