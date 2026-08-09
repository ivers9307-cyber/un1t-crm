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
  const searchParams = await props.searchParams;
  return <UnsubscribePage token={params.token} locationId={searchParams?.l || null} />
}
