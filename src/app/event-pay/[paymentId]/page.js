// /event-pay/[paymentId] — embedded checkout for a race registration.
//
// Public page. The race_payments row was created by the public
// register route; this page only mounts the Revolut Embedded
// Checkout SDK against the existing order.
//
// SEPARATE from /deposit/[token]/page.js (cars deposit) — same SDK,
// different domain (UN1T races vs CCF Autos), different copy, no
// T&Cs step.

import { Poppins } from 'next/font/google'
import RaceCheckoutPage from '@/components/RaceCheckoutPage'

const poppins = Poppins({
  weight: ['400', '500', '600', '700', '800'],
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export const runtime = 'nodejs'

export default async function Page(props) {
  const params = await props.params;
  return (
    <div className={`${poppins.variable} font-body`}>
      <RaceCheckoutPage paymentId={params.paymentId} />
    </div>
  )
}
