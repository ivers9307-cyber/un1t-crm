// PAGES.1 — the wrapper a studio page (/stillorgan, /hatch-street and their
// /events and /status) renders inside on the one [slug] route: the marketing
// typography and the #lp-shell element the scroll-reveal script arms. It is
// what src/app/welcome/layout.js gave these pages when they lived under
// /welcome, so moving them changes nothing visible. Campaign pages never had
// it and do not get it here.
//
// No VisitOriginCapture: BlocksLayout mounts its own, and the two sub-pages
// mount theirs, so each page has exactly one (as under /welcome).

import { poppinsBody as poppins } from '@/fonts/poppins'

// `pageLocationId`: the studio the page speaks for, as `data-page-location`
// (read by pageLocationIdFromDocument for the studio's Meta pixel).
export default function StudioShell({ children, pageLocationId = null }) {
  // id="lp-shell": reveal-arm.js adds `lp-armed` to THIS element during HTML
  // parse; suppressHydrationWarning covers that one pre-hydration mutation.
  return (
    <div id="lp-shell" data-page-location={pageLocationId || undefined} suppressHydrationWarning className={`${poppins.variable} font-body`}>
      {children}
    </div>
  )
}
