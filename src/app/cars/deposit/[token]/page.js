// Public car-deposit page. No auth — the token in the URL is the
// only credential. Static-shell-friendly: page itself does no DB
// work, the client component fetches via the public API.

import CarDepositPage from '@/components/CarDepositPage'

export const dynamicParams = true
export const revalidate = 0   // status changes between visits — never cache the shell

export const metadata = {
  title: 'Tesla Car Deposit',
}

export default function DepositPage({ params }) {
  return <CarDepositPage token={params.token} />
}
