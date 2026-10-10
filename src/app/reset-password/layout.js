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
// Scope: /reset-password — reached from an emailed recovery link by staff AND
// by members, so it is treated as customer-facing. The page itself is a client
// component and cannot export metadata; this layout is the only place to put
// it.

import { headers } from 'next/headers'
import { customerFacingMetadata } from '@/lib/default-site-name'

export async function generateMetadata() {
  return customerFacingMetadata({ host: (await headers()).get('host') })
}

export default function ResetPasswordLayout({ children }) {
  return children
}
