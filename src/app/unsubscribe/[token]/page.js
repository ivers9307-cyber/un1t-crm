import UnsubscribePage from '@/components/UnsubscribePage'

// Public, no auth, no server data fetch — let Next.js render a static
// shell that UnsubscribePage then hydrates client-side.
export const dynamicParams = true
export const revalidate = 3600

export const metadata = {
  title: 'Unsubscribe — UN1T',
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
