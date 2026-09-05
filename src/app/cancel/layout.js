// /cancel segment layout — marketing-site typography (CANCEL-FORM.3).
//
// The cancellation form is a CUSTOMER surface reached from an email or a
// WhatsApp message, so it must look like the studio, not the staff CRM.
// Mirrors src/app/preferences/layout.js: Poppins via next/font, scoped to
// this segment so the CRM never pays the font bytes.

import { poppinsBody as poppins } from '@/fonts/poppins'

export const metadata = {
  title: 'Your membership',
  robots: { index: false, follow: false },
}

export default function CancelLayout({ children }) {
  return (
    <div className={`${poppins.variable} font-body`}>
      {children}
    </div>
  )
}
