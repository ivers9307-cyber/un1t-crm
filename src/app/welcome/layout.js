// /welcome segment layout — marketing-site typography.
//
// Loads the brand font via next/font (self-hosted at build time: zero
// external requests, zero layout shift) and exposes it as a CSS
// variable consumed by the `font-display` / `font-body` Tailwind
// families (tailwind.config.js). Scoped HERE rather than the root
// layout so the CRM app never pays the font bytes and keeps its
// default stack.
//
// Poppins ONLY (operator decision 2026-06-11) — the repo's documented
// SIL stand-in for the brand font NEXA. Display type is Poppins at
// heavy weights (700–800) rather than a second family; both Tailwind
// families resolve to this one variable.
//
// Everything under /welcome inherits this: the split chooser, the
// per-studio pages, the edit-mode preview iframe (?edit=1) and the
// dev preview harness — so the editor previews exactly what ships.

import { poppinsBody as poppins } from '@/fonts/poppins'

export default function WelcomeLayout({ children }) {
  // id="lp-shell": the reveal arming script (reveal-arm.js) adds the
  // `lp-armed` class to THIS element during HTML parse — scoping the
  // scroll-reveal system to the marketing segment without touching the
  // shared <html>/<body>. suppressHydrationWarning covers exactly that
  // one pre-hydration class mutation (the next-themes pattern).
  return (
    <div
      id="lp-shell"
      suppressHydrationWarning
      className={`${poppins.variable} font-body`}
    >
      {children}
    </div>
  )
}
