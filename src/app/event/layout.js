// CHROME.1 REVIEW — customer-facing metadata.
//
// This subtree declared no metadata, so it inherited the ROOT layout's —
// which CHROME.1 moved onto the PLATFORM name ("Repset") because that layout
// labels ~160 staff pages. Prod has no configured company_name, so the root
// really does resolve to "Repset", and a customer here would have read a
// brand they have no relationship with in place of the gym's name.
//
// customerFacingMetadata() reads the same operator-editable
// company_settings.company_name and floors on the GYM wordmark instead —
// the same value the login screen, contract emails and Mia already render.
//
// Scope: /event/[slug]/confirmed (the post-payment page a paying attendee
// lands on) and /event/[slug]/display (the race-day board on a studio TV).
// /event/[slug] itself already exports a RICHER generateMetadata — the actual
// event name and description — and that page-level export still wins here;
// this layout only catches the two children that had nothing.
//
// The display board is a gym-floor surface, and the locked decision holds:
// it resolves the GYM identity, never the platform's.

import { customerFacingMetadata } from '@/lib/default-site-name'

export async function generateMetadata() {
  return customerFacingMetadata()
}

export default function EventLayout({ children }) {
  return children
}
