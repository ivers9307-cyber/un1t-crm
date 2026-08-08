// /preferences segment layout — marketing-site typography.
//
// LOCCOMMS.4. The preference centre is a CUSTOMER surface reached from a
// marketing email, so it must look like un1tdublin.com, not like the staff CRM.
// It previously rendered on the CRM's light admin tokens (bg-un1t-bg /
// un1t-surface), which is a jarring hand-off from a black, Poppins-set email.
//
// Mirrors src/app/welcome/layout.js exactly: loads the brand font via
// next/font (self-hosted at build time — zero external requests, zero layout
// shift) and exposes it as the CSS variable the `font-display` / `font-body`
// Tailwind families consume. Scoped to this segment so the CRM never pays the
// font bytes.
//
// Poppins ONLY (operator decision 2026-06-11) — the repo's documented SIL
// stand-in for the brand font NEXA.

import { poppinsBody as poppins } from '@/fonts/poppins'

export const metadata = {
  title: 'Your communication preferences — UN1T',
}

export default function PreferencesLayout({ children }) {
  return (
    <div className={`${poppins.variable} font-body`}>
      {children}
    </div>
  )
}
