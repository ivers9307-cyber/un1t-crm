// TV-TEMPLATE.7 — brand font for zone text + the idle view.
//
// Poppins is the operator-chosen face for TV template surfaces
// (Richard, 2026-07-10 — "poppins is the only font needed"),
// replacing the Montserrat stand-in used while NEXA (the CRM brand
// face) remained unlicensed in this repo. Heavy weights read well
// at a distance on a gym TV, and next/font self-hosts it at build
// time (no external request from the cast page, no layout shift).
//
// Imported once here (module scope, per next/font's rule) and
// reused by TemplateCanvas (zone text), TemplateEditor (ZoneBox
// preview text) and TVDisplay (idle-view mark + clock) so every
// surface that can show template text agrees on the face.
import { poppinsTv } from '@/fonts/poppins'

export const tvFont = poppinsTv

// Fallback stack appended after the brand face — matches the
// system-ui stack TVDisplay already sets on its outer wrapper, so
// a font-load failure degrades to the same look as before this
// change.
export const tvFontFamily = `${tvFont.style.fontFamily}, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`
