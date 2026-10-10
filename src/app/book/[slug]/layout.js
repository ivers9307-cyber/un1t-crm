// CHROME.1 REVIEW — customer-facing metadata.
//
// This subtree declared no metadata, so it inherited the ROOT layout's —
// which CHROME.1 moved onto the PLATFORM name ("Repset") because that layout
// labels ~160 staff pages. Prod has no configured company_name, so the root
// really does resolve to "Repset", and a customer here would have read a
// brand they have no relationship with in place of the gym's name.
//
// customerFacingMetadata({ host }) resolves the REQUEST HOST's organisation
// brand (W1.L4: org_settings → that org's company_settings → location name)
// and floors on the platform name when the host has no organisation — so a
// tenant's customers read the tenant's gym, and never another tenant's.
//
// Scope: /book/[slug] — the public class-booking page, the single most-shared
// customer link in the product. This layout already existed (it supplies the
// clean no-sidebar shell); before CHROME.1 it declared no metadata.

import { headers } from 'next/headers'
import { customerFacingMetadata } from '@/lib/default-site-name'

export async function generateMetadata() {
  return customerFacingMetadata({ host: (await headers()).get('host') })
}

export default function BookingLayout({ children }) {
  return (
    <div className="min-h-screen bg-white text-gray-900 flex items-start justify-center p-4 md:p-8">
      {children}
    </div>
  )
}
