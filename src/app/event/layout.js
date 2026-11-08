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
// Scope: /event/[slug]/confirmed (the post-payment page a paying attendee
// lands on) and /event/[slug]/display (the race-day board on a studio TV).
// /event/[slug] itself already exports a RICHER generateMetadata — the actual
// event name and description — and that page-level export still wins here;
// this layout only catches the two children that had nothing.
//
// The display board is a gym-floor surface, and the locked decision holds:
// it resolves the GYM identity, never the platform's.

import { headers } from 'next/headers'
import { customerFacingMetadata } from '@/lib/default-site-name'
import EventAttributionCapture from '@/components/EventAttributionCapture'

export async function generateMetadata() {
  return customerFacingMetadata({ host: (await headers()).get('host') })
}

// HOSTSTATS.1 — every /event/* page (the event page, the series page, the
// confirmed page) keeps the tab's first-touch attribution, so a reader who
// lands on a series page from a host email and picks a date still books as
// host_email. (/h/<slug> mounts the same capture itself.)
export default function EventLayout({ children }) {
  return (
    <>
      <EventAttributionCapture />
      {children}
    </>
  )
}
