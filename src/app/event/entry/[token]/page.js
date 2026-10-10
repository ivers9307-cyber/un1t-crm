// /event/entry/[token] — EVENT-MOVE.6: the person who booked an event entry
// views it and changes its date themselves, from the "Change your date" link
// in their confirmation and moved emails.
//
// Public page: no session. It lives under /event/ (outside every auth-gated
// segment) and is on all FOUR public-path allowlists (proxy, AppShell,
// brands, tenant-domains-edge; src/public-compliance-paths.test.jsx), with
// the checkout it may hand off to (/event-pay/). The token in the path is the
// only credential and is checked by the /api/public/entry/[token] routes the
// client component calls; nothing is read here.

import { poppinsBody as poppins } from '@/fonts/poppins'
import EntryManagePage from '@/components/EntryManagePage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A personal link: never index it, never leak it as a referrer.
export const metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function Page(props) {
  const params = await props.params
  return (
    <div className={`${poppins.variable} font-body`}>
      <EntryManagePage token={params.token} />
    </div>
  )
}
