// Post-payment landing. Revolut redirects the buyer here after
// success OR failure on the hosted checkout. The webhook is the
// authoritative source for status — this page just re-fetches the
// public deposit data (which reflects whatever state the webhook
// has applied) and shows the right message.

import CarDepositPage from '@/components/CarDepositPage'

export const dynamicParams = true

export const metadata = {
  title: 'Car Deposit',
}

export default async function DepositReturnPage(props) {
  const params = await props.params;
  // Same component handles 'paid' and 'pending' states uniformly —
  // if the webhook has landed the page renders the receipt; if not,
  // the buyer can re-attempt.
  return <CarDepositPage token={params.token} />
}
