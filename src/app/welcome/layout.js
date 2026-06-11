// /welcome segment layout — marketing-site typography.
//
// Loads the two brand fonts via next/font (self-hosted at build time:
// zero external requests, zero layout shift) and exposes them as CSS
// variables consumed by the `font-display` / `font-body` Tailwind
// families (tailwind.config.js). Scoped HERE rather than the root
// layout so the CRM app never pays the font bytes and keeps its
// default stack.
//
// Anton    — display. Ultra-bold condensed; the gym-poster voice.
// Poppins  — body/UI. The repo's documented SIL stand-in for the
//            brand font NEXA (see CLAUDE.md, app-icon section).
//
// Everything under /welcome inherits this: the split chooser, the
// per-studio pages, the edit-mode preview iframe (?edit=1) and the
// dev preview harness — so the editor previews exactly what ships.

import { Anton, Poppins } from 'next/font/google'

const anton = Anton({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

const poppins = Poppins({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

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
      className={`${anton.variable} ${poppins.variable} font-body`}
    >
      {children}
    </div>
  )
}
