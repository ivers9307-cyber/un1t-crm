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
// Scope: /account and everything under it — the members own self-service
// preferences and contracts. Authenticated, but the audience is the customer.

import { customerFacingMetadata } from '@/lib/default-site-name'

export async function generateMetadata() {
  return customerFacingMetadata()
}

export default function AccountLayout({ children }) {
  return children
}
