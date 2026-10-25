// /pay-done segment layout — studio-site typography (MIAHATCH.6).
//
// The return page of un1t.online's hosted checkout is a CUSTOMER surface (a
// member lands on it from a card form), so it must look like the studio, not
// the staff CRM. Mirrors src/app/cancel/layout.js: Poppins via next/font,
// scoped to this segment so the CRM never pays the font bytes. The token in
// the URL is a credential, so the page is noindex and sends no referrer.

import { poppinsBody as poppins } from '@/fonts/poppins'

export const metadata = {
  title: 'Payment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function PayDoneLayout({ children }) {
  return (
    <div className={`${poppins.variable} font-body`}>
      {children}
    </div>
  )
}
