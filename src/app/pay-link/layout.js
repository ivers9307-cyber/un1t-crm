// /pay-link segment layout — studio-site typography (UN1TDUN.1).
//
// A member opens this from a payment reminder on WhatsApp, so it must look
// like the studio, not the staff CRM. Mirrors src/app/fee-appeal/layout.js.
// The token in the URL is a credential, so the page is noindex and sends no
// referrer (the Stripe page it redirects to never learns our URL).

import { poppinsBody as poppins } from '@/fonts/poppins'

export const metadata = {
  title: 'Payment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function Un1tPayLayout({ children }) {
  return (
    <div className={`${poppins.variable} font-body`}>
      {children}
    </div>
  )
}
