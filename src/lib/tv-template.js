// TV-TEMPLATE — moved to shared/tv-template.js so the mobile app
// can use the same zone resolution + colour-run logic (mobile can't
// import src/lib; shared/ is the seam). This shim keeps every
// existing '@/lib/tv-template' import working.

export {
  resolveZone,
  mergeRuns,
  setRunColor,
  clearRunColor,
  shiftRuns,
  textSegments,
  // TV-STYLE.1 — unified style runs.
  mergeStyleRuns,
  setRunStyle,
  clearRunStyle,
  rangeStyle,
  lineRangeAt,
  MIN_FIT_PX,
  nextFitPx,
  seedFitPx,
  fitStepFromLines,
  FLEX_V,
  FLEX_H,
} from '@shared/tv-template'
