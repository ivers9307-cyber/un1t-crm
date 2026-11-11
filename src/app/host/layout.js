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

import { headers, cookies } from 'next/headers'
import { customerFacingMetadata } from '@/lib/default-site-name'
import { HOST_THEME_COOKIE, hostThemeFromCookie } from '@/lib/host-theme'

export async function generateMetadata() {
  return customerFacingMetadata({ host: (await headers()).get('host') })
}

// HOSTTHEME.1: the theme wrapper. The cookie is read on the server so the first
// paint is already the host's choice; with no choice it is light (HOSTTHEME.2),
// whatever the device prefers. The same wrapper covers login, set-password and
// the portal.
export default async function HostLayout({ children }) {
  const theme = hostThemeFromCookie((await cookies()).get(HOST_THEME_COOKIE)?.value)
  return (
    <div data-host-theme={theme} className="min-h-screen bg-host-bg text-host-text">
      {children}
    </div>
  )
}
