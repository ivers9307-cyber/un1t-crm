import { headers } from 'next/headers'
import UnsubscribePage from '@/components/UnsubscribePage'
import { resolveScopedBrandName } from '@/lib/host-brand'

// Public, no auth, no server data fetch for the body — UnsubscribePage
// hydrates client-side. W1.L4: the title resolves by request (the `?l=`
// studio, else the host), which is a dynamic read, so the former static
// shell (`revalidate = 3600`) is now rendered per request.
export const dynamic = 'force-dynamic'

// W1.L4 — the tab names the gym whose email this was: the `?l=<locationId>`
// scope buildUnsubscribeUrl appends (that studio's brand chain), else the
// request host's organisation brand. Never a literal — and never ANOTHER
// tenant's: `?l=` is caller-controlled, so resolveScopedBrandName honours it
// only when it is a UUID (the API route's gate) AND the location belongs to
// the host's organisation, or the host has no organisation (a CRM-host link,
// where every link was minted before W1.L3). A non-UUID costs no read.
export async function generateMetadata(props) {
  const searchParams = await props.searchParams
  const brand = await resolveScopedBrandName({
    host: (await headers()).get('host'),
    locationId: typeof searchParams?.l === 'string' ? searchParams.l : null,
  })
  return { title: `Unsubscribe — ${brand}` }
}

export default async function Unsubscribe(props) {
  const params = await props.params;
  // COMMSFIX.A.2 (LOCCOMMS.4) — buildUnsubscribeUrl appends ?l=<locationId>
  // so the opt-out scopes to the studio whose email this was. Thread it into
  // the client component so its POST carries the same scope; absent l keeps
  // the global opt-out (back-compat for already-delivered unscoped links).
  //
  // UNSUBAUTO.4 — `?c=` rides along too. buildUnsubscribeUrl appends it to name
  // the campaign whose email carried the link, and the API route reads it to
  // attribute the opt-out (increment_campaign_metric → campaigns.total_unsubscribed).
  // This page threaded only `l`, so every page-path opt-out went uncounted and
  // an operator reading total_unsubscribed to spot a campaign that burned the
  // list saw a number well under reality. UNSUBAUTO.1 multiplies page-path
  // opt-outs, which multiplies the undercount with them.
  const searchParams = await props.searchParams;
  return (
    <UnsubscribePage
      token={params.token}
      locationId={searchParams?.l || null}
      campaignId={searchParams?.c || null}
    />
  )
}
