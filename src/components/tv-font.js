// TV-TEMPLATE.7 — brand font for zone text + the idle view.
//
// The CRM brand face is NEXA (not licensed in this repo — see the
// /welcome layout's Poppins note for the same constraint on the
// marketing site). Montserrat is a close-enough geometric-sans
// stand-in for TV surfaces: heavy weights read well at a distance
// on a gym TV, and next/font self-hosts it at build time (no
// external request from the cast page, no layout shift).
//
// Imported once here (module scope, per next/font's rule) and
// reused by TemplateCanvas (zone text), TemplateEditor (ZoneBox
// preview text) and TVDisplay (idle-view mark + clock) so every
// surface that can show template text agrees on the face.
import { Montserrat } from 'next/font/google'

export const tvFont = Montserrat({
  weight: ['400', '600', '700', '800', '900'],
  subsets: ['latin'],
  display: 'swap',
})

// Fallback stack appended after the brand face — matches the
// system-ui stack TVDisplay already sets on its outer wrapper, so
// a font-load failure degrades to the same look as before this
// change.
export const tvFontFamily = `${tvFont.style.fontFamily}, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`
