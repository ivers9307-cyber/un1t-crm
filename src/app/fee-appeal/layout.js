// /fee-appeal segment layout — studio-site typography (FEES.3).
//
// A member opens this from their class-fee notice (or a link staff sent), so
// it must look like the studio, not the staff CRM. Mirrors
// src/app/pay-done/layout.js. The token in the URL is a credential, so the
// page is noindex and sends no referrer.

import { poppinsBody as poppins } from '@/fonts/poppins'

export const metadata = {
  title: 'Class fee',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function FeeAppealLayout({ children }) {
  return (
    <div className={`${poppins.variable} font-body`}>
      {children}
    </div>
  )
}
