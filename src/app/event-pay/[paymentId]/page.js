// /event-pay/[paymentId] — embedded checkout for a race registration.
//
// Public page. The race_payments row was created by the public
// register route; this page only mounts the Revolut Embedded
// Checkout SDK against the existing order.
//
// SEPARATE from /deposit/[token]/page.js (cars deposit) — same SDK,
// different domain (UN1T races vs CCF Autos), different copy, no
// T&Cs step.

import RaceCheckoutPage from '@/components/RaceCheckoutPage'

export const runtime = 'nodejs'

export default function Page({ params }) {
  return <RaceCheckoutPage paymentId={params.paymentId} />
}
