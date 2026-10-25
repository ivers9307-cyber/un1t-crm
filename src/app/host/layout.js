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
// Scope: /host/login, /host/set-password and the gated /host/(portal) pages.
// The (portal) route group keeps its own layout (the host-session gate); this
// one sits above it and only contributes metadata, so both the gated and the
// ungated host pages are covered.

import { headers } from 'next/headers'
import { customerFacingMetadata } from '@/lib/default-site-name'

export async function generateMetadata() {
  return customerFacingMetadata({ host: (await headers()).get('host') })
}

export default function HostLayout({ children }) {
  return children
}
