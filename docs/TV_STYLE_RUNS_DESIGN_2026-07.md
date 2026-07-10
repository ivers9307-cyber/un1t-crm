# TV-STYLE — per-line / per-selection style runs for TV template zones

**Date:** 2026-07-10 · **Approved by:** Richard (chat) · **Status:** building

## Problem

TV template zones style the whole zone at once (one fontSize / fontWeight /
color), with per-character COLOUR runs as the only exception (TV-TEMPLATE.5,
web only). Operators building workout boards need per-line and per-selection
styling — heading big/red, list lines small/white, a word bolded — editable
from mobile AND web. There is no underline anywhere, and the zone font must
be Poppins (Richard: "poppins is the only font needed" — replaces Montserrat;
no font picker).

## Decisions (from brainstorm with Richard)

1. Granularity: **both** per-line and per-selection → one unified model.
2. Fonts: **Poppins only**, everywhere TV template text renders. No picker.
3. Edit surfaces: **mobile + web in the same round**.
4. Editor semantics: **collapsed cursor → style the whole line the cursor is
   on; non-empty selection → style just the selection.** Live preview on both
   platforms shows every change.

## Data model (shared/tv-template.js is canonical)

`template_values[zoneId].styleRuns` (and template zone default
`zone.styleRuns`): array of half-open character ranges over the zone text:

```js
{ start, end, color?, fontSize?, bold?, underline? }
```

- `fontSize` — % of base-image height, same unit as zone fontSize (2–40).
- `bold` — boolean. true → weight 800, false → weight 400, absent → zone
  fontWeight.
- `underline` — boolean. absent/false → none.
- `color` — CSS hex, absent → zone color.
- Runs are kept sorted, non-empty, non-overlapping; adjacent runs merge only
  when ALL style props are equal.
- **Back-compat:** legacy `colorRuns` (colour-only) are folded into
  `styleRuns` at resolve time — old pushes render unchanged, no migration.
  Where both exist on a value, `styleRuns` wins on overlap.

### Shared helpers (all pure, all vitest-covered, tests FIRST)

- `resolveZone(zone, value)` — unchanged contract, but output gains
  `styleRuns` (legacy colorRuns folded in; output keeps `colorRuns` too so
  existing callers don't break during rollout).
- `mergeStyleRuns(runs)` — sort, drop empties, merge adjacent equal-style.
- `setRunStyle(runs, start, end, patch)` — overlay `patch` props on the range
  PRESERVING other props already present (per-property merge, not replace).
  Implementation freedom: per-char expand → patch → re-encode is fine
  (zone text is small).
- `clearRunStyle(runs, start, end, keys)` — remove the given prop keys (or
  all props when keys omitted) from the range.
- `rangeStyle(runs, start, end)` — the effective props over a range where
  they are uniform (`{ bold: true }` only if EVERY char in range is bold);
  used by editors to decide toggle direction and show active states.
- `lineRangeAt(text, index)` — `{start, end}` of the line containing `index`
  (end excludes the trailing `\n`). Cursor-→-line targeting for editors.
- `shiftRuns(runs, oldText, newText)` — existing, generalised to carry ALL
  run props through the remap (currently rebuilds only `color`).
- `textSegments(text, runs, baseColor)` — existing, generalised: segments
  become `{ text, color, fontSize?, bold?, underline? }`, split wherever any
  prop changes.
- Keep `mergeRuns`/`setRunColor`/`clearRunColor` exported as thin wrappers
  (colour-only) so current web code + tests keep passing until the editors
  are updated; existing tests must stay green unmodified.

## Rendering

Mixed sizes must still auto-fit: **the fitted size is a single scale factor
applied to every segment proportionally.**

- **Web `src/components/TemplateCanvas.jsx` Zone:** container fontSize stays
  the `useFitText`-fitted base px. Segments with `fontSize` render as
  `em` = `run.fontSize / zone.fontSize` (ratio of the two percentages —
  independent of px, so useFitText's measure loop keeps working untouched).
  `bold` → span fontWeight 800/400; `underline` → textDecoration underline.
  Unitless lineHeight already scales per-span. Add `styleRuns` (JSON string)
  to the useFitText deps. Same treatment in
  `src/app/admin/tv-displays/TemplateEditor.jsx`'s ZoneBox preview.
- **Mobile `mobile/components/TvTemplateCanvas.jsx` ZoneBox:** per-segment
  nested `<Text>` gets `fontSize = segPct/zonePct * fitPx`, matching
  `lineHeight = that × resolved.lineHeight`, fontWeight from bold, and
  `textDecorationLine: 'underline'`. The TV-MOBILE.G measured fit loop
  (outer onTextLayout) is unchanged; add styleRuns to the fitKey.

## Poppins

- **Web `src/components/tv-font.js`:** swap Montserrat → Poppins (next/font
  google, weights 400/600/700/800/900, same fallback stack, same exports).
  Every TV template surface + idle clock updates via the existing import.
- **Mobile:** add `@expo-google-fonts/poppins` (400/600/700/800) +
  `useFonts` in `mobile/app/_layout.jsx` (non-blocking — render app while
  loading; canvas falls back to system font until ready). expo-font native
  module is already in the build (Ionicons dep) → OTA-safe, no native
  release. RN custom fonts are one family PER WEIGHT: add
  `poppinsFamily(weight)` helper in the mobile canvas mapping
  400→Poppins_400Regular, 600→Poppins_600SemiBold, 700→Poppins_700Bold,
  800+→Poppins_800ExtraBold (nearest-weight for other values), and stop
  relying on the `fontWeight` style for the zone text (RN ignores it for
  single-weight custom families). If you touch `mobile/package.json`, re-sync
  the lock: `cd mobile && npm install --package-lock-only`.

## Editors (same semantics both platforms)

Toolbar under each zone's text input: **size − / size +** (steps the
effective fontSize % by 1, clamped 2–40), **colour swatches** (reuse the web
push modal's existing palette), **B**, **U**. Target = selection if
non-empty else `lineRangeAt(cursor)`. B/U toggle by `rangeStyle`: if the
whole target already has the prop → clear it, else set it. Size step reads
the target's uniform effective size (falling back to zone size) and writes
`fontSize: current ± 1`. Text edits remap runs via `shiftRuns`.

- **Web:** `src/app/admin/tv-displays/TVAdmin.jsx` push-modal zone editor —
  replace the colour-paint-only selection UI with the full toolbar; textarea
  selection via onSelect (already tracked for colour runs). Writes
  `styleRuns` (stop writing `colorRuns` for new edits).
- **Mobile:** `mobile/components/TvPushModal.jsx` zone editor — track
  selection via `onSelectionChange` into a ref+state; toolbar buttons must
  not clobber the selection (modal already uses
  `keyboardShouldPersistTaps="handled"`; keep the input focused or cache the
  last selection). Live preview above already re-renders per keystroke via
  `values` — style writes flow the same way.

## Testing / verification

- Shared helpers: vitest, tests written before implementation, in
  `src/lib/tv-template.test.js` (existing tests stay green **unmodified**).
- CI mirror + `npm run build` before PR (build is the import-resolution
  gate).
- Device pass after OTA: one mobile push styling a line + a selection;
  glance at the Stillorgan cast TV for Poppins + styled render.

## Out of scope

Font picker (Poppins only), per-zone underline default, template-editor
(zone-default) style-run editing, champ-app (CRM-only feature), multi-TV
push, content expiry.
