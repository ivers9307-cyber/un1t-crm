// Public car-deposit page. No auth — the token in the URL is the
// only credential. Lives at /deposit/<token> rather than under /cars/
// so it doesn't inherit the /cars/layout.js auth gate (which would
// redirect anonymous buyers to /login).

import CarDepositPage from '@/components/CarDepositPage'

export const dynamicParams = true
export const revalidate = 0   // status changes between visits — never cache the shell

export const metadata = {
  title: 'Tesla Car Deposit',
}

export default function DepositPage({ params }) {
  return <CarDepositPage token={params.token} />
}
