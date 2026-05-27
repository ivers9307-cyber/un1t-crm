// STUDIO-IPAD.1 — pure breakpoint constants for the tablet/phone
// device-class decision.
//
// Split out from use-is-tablet.js (which imports react-native via
// useWindowDimensions) so vitest can exercise the values without
// pulling RN into the test runtime. Mirrors the
// motion-aware-stack-options.js / use-reduced-motion.js split.

/**
 * Width threshold (in points) above which we treat the viewport as a
 * tablet. Chosen so:
 *
 *   - iPhone (320–430pt wide) → phone (single column)
 *   - iPad Mini portrait (768pt) → tablet (split layouts)
 *   - iPad 1/3 Slide Over (~320pt) → phone (intentional — Slide Over
 *     is a narrow side panel)
 *   - iPad 1/2 split (~507pt on 11") → phone (still cramped for two
 *     columns)
 *   - iPad full-screen or 2/3 split on 13" (~700pt+) → tablet
 *
 * Keep this constant in lockstep with any design tokens or per-screen
 * media queries that consume it.
 */
export const TABLET_BREAKPOINT_PT = 700

/**
 * Suggested master-pane width for master-detail layouts on tablet.
 * Tuned for a readable contact / approvals list; per-screen layouts
 * can override.
 */
export const MASTER_PANE_WIDTH_PT = 360

/**
 * Pure decision: is this viewport width in tablet territory?
 * Exported so callers that have width from a different source (e.g.
 * a Dimensions.get('window') snapshot at mount time) can reuse the
 * same threshold without going through the hook.
 */
export function isTabletWidth(widthPt) {
  return typeof widthPt === 'number' && widthPt >= TABLET_BREAKPOINT_PT
}
