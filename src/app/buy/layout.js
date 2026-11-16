// /buy segment layout — studio-site typography (STAFFPAYLINK.1).
//
// A customer opens this from a staff-sent payment link on WhatsApp, so it
// must look like the studio, not the staff CRM. Mirrors
// src/app/pay-link/layout.js. The token in the URL is a credential, so the
// page is noindex and sends no referrer (un1t.online's checkout never learns
// our URL).

import { poppinsBody as poppins } from '@/fonts/poppins'

export const metadata = {
  title: 'Payment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function BuyLayout({ children }) {
  return (
    <div className={`${poppins.variable} font-body`}>
      {children}
    </div>
  )
}
