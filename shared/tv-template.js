// TV-TEMPLATE.2 — per-zone style resolution.
//
// A template zone (tv_templates.zones[*]) carries default styling:
// text, fontSize, fontWeight, color, align, vAlign, uppercase.
//
// When a template is pushed, the operator can override any of those
// per zone on the push screen. Those overrides live in
// tv_content.template_values keyed by zone id.
//
// `template_values[zoneId]` can be one of two shapes:
//   - legacy: a plain string (TV-TEMPLATE.1 stored text only)
//   - current: an object { text, fontSize, fontWeight, color,
//     align, vAlign, uppercase } — any field may be absent
//
// resolveZone merges a zone definition with its push-time value
// and always returns a fully-populated, render-ready style object,
// so callers (the cast page + the admin previews) never branch on
// the stored shape.

const ALIGN = ['left', 'center', 'right']
const VALIGN = ['top', 'middle', 'bottom']

function pickNum(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * Merge a zone's template default with the pusher's per-zone value.
 *
 * Covers text, styling AND geometry: the push screen (TV-TEMPLATE.4)
 * lets the operator drag/resize a zone, so x/y/width/height can be
 * overridden per push just like the text and colours.
 *
 * @param {object} zone  one entry of tv_templates.zones
 * @param {object|string|null|undefined} value  template_values[zone.id]
 * @returns {{text:string,fontSize:number,fontWeight:number,color:string,
 *            align:string,vAlign:string,uppercase:boolean,lineHeight:number,
 *            x:number,y:number,width:number,height:number}}
 */
export function resolveZone(zone = {}, value) {
  // Legacy plain-string value → treat as a text-only override.
  const v = value && typeof value === 'object' ? value : { text: value }

  return {
    text: (v.text ?? zone.defaultText ?? '').toString(),
    // fontSize is a % of the base-image height (2–40).
    fontSize: pickNum(v.fontSize, pickNum(zone.fontSize, 6)),
    fontWeight: pickNum(v.fontWeight, pickNum(zone.fontWeight, 700)),
    color: (typeof v.color === 'string' && v.color) || zone.color || '#FFFFFF',
    align: pickEnum(v.align, ALIGN, pickEnum(zone.align, ALIGN, 'center')),
    vAlign: pickEnum(v.vAlign, VALIGN, pickEnum(zone.vAlign, VALIGN, 'middle')),
    uppercase: typeof v.uppercase === 'boolean' ? v.uppercase : !!zone.uppercase,
    lineHeight: pickNum(v.lineHeight, pickNum(zone.lineHeight, 1.15)),
    // Geometry — all % of the base image.
    x: pickNum(v.x, pickNum(zone.x, 0)),
    y: pickNum(v.y, pickNum(zone.y, 0)),
    width: pickNum(v.width, pickNum(zone.width, 100)),
    height: pickNum(v.height, pickNum(zone.height, 100)),
    // TV-TEMPLATE.5 — per-character colour overrides. Array of
    // { start, end, color }; any text not covered uses `color`.
    colorRuns: Array.isArray(v.colorRuns)
      ? v.colorRuns
      : (Array.isArray(zone.colorRuns) ? zone.colorRuns : []),
  }
}

// ── Colour runs (TV-TEMPLATE.5) ─────────────────────────────────
//
// A zone's text is one string with one base colour. To colour part
// of it, the push screen records "colour runs" — half-open
// character ranges { start, end, color } — kept sorted and
// non-overlapping. The base colour fills any gap.

// Sort runs, drop empties, and merge touching runs of equal colour.
export function mergeRuns(runs) {
  const sorted = (runs || [])
    .filter(r => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map(r => ({ start: Math.floor(r.start), end: Math.floor(r.end), color: r.color }))
    .sort((a, b) => a.start - b.start)
  const out = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.color === r.color && last.end >= r.start) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

// Clip every existing run so nothing covers [start, end).
function carve(runs, start, end) {
  const out = []
  for (const r of runs || []) {
    if (r.end <= start || r.start >= end) { out.push(r); continue }
    if (r.start < start) out.push({ ...r, end: start })
    if (r.end > end) out.push({ ...r, start: end })
  }
  return out
}

// Paint [start, end) with `color` (replacing any run there).
export function setRunColor(runs, start, end, color) {
  if (!(end > start)) return mergeRuns(runs)
  return mergeRuns([...carve(runs, start, end), { start, end, color }])
}

// Revert [start, end) to the base colour (remove runs there).
export function clearRunColor(runs, start, end) {
  if (!(end > start)) return mergeRuns(runs)
  return mergeRuns(carve(runs, start, end))
}

// Remap run offsets after the text is edited, by diffing the old
// and new strings (common prefix / suffix). Keeps colour roughly
// attached to the same words through inserts + deletes.
export function shiftRuns(runs, oldText, newText) {
  const o = oldText || '', n = newText || ''
  if (o === n) return mergeRuns(runs)
  let p = 0
  while (p < o.length && p < n.length && o[p] === n[p]) p++
  let s = 0
  while (s < o.length - p && s < n.length - p &&
         o[o.length - 1 - s] === n[n.length - 1 - s]) s++
  const oldMid = o.length - p - s
  const delta = (n.length - p - s) - oldMid
  const remap = (i) => {
    if (i <= p) return i
    if (i >= p + oldMid) return i + delta
    return p   // inside the edited span — collapse to its start
  }
  return mergeRuns((runs || []).map(r => ({
    start: remap(r.start), end: remap(r.end), color: r.color,
  })))
}

// Split `text` into contiguous { text, color } segments for render.
export function textSegments(text, runs, baseColor) {
  const str = text == null ? '' : String(text)
  const base = baseColor || '#FFFFFF'
  const n = str.length
  if (n === 0) return [{ text: '', color: base }]
  const colors = new Array(n).fill(base)
  for (const r of runs || []) {
    if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end)) continue
    const a = Math.max(0, Math.floor(r.start))
    const b = Math.min(n, Math.floor(r.end))
    for (let i = a; i < b; i++) colors[i] = r.color || base
  }
  const segs = []
  let start = 0
  for (let i = 1; i <= n; i++) {
    if (i === n || colors[i] !== colors[start]) {
      segs.push({ text: str.slice(start, i), color: colors[start] })
      start = i
    }
  }
  return segs
}

// ── Auto-fit (TV-TEMPLATE.6 / TV-MOBILE.G) ──────────────────────
//
// A zone's fontSize is a MAXIMUM, not an exact size: both renderers
// measure the laid-out text and shrink until it fits its zone box.
// The measurement is platform-specific (DOM scrollHeight on web,
// onTextLayout lines on RN) but the convergence step is shared here
// so the TV, the web preview and the mobile preview all agree.

// Floor so a giant paste still reads as "small text" rather than
// disappearing entirely.
export const MIN_FIT_PX = 9

// Pure step of the fit loop: given the current font size and how
// much the text block overflows its box on each axis, return the
// next (smaller-or-equal) font size to try.
export function nextFitPx(currentPx, scaleH, scaleW, minPx = MIN_FIT_PX) {
  const scale = Math.min(1, scaleH, scaleW)
  if (!Number.isFinite(scale) || scale <= 0) return minPx
  return Math.max(minPx, currentPx * scale)
}

// Starting size for a measure loop: the operator's max, pre-capped
// so every hard newline gets a line slot in the zone's height.
// Wrapping-induced overflow still converges via measurement — this
// just stops a 13-line paste from first painting (and, on RN,
// truncating) at full size before the loop kicks in.
export function seedFitPx(text, boxH, lineHeightRatio, maxPx, minPx = MIN_FIT_PX) {
  const lineCount = String(text ?? '').split('\n').length
  const cap = boxH / (lineCount * lineHeightRatio)
  const floor = Math.min(minPx, maxPx)
  return Math.max(floor, Math.min(maxPx, cap))
}

// RN measurement step: `lines` is onTextLayout's nativeEvent.lines
// ([{ width, height }]). Returns whether the block fits `boxW`×`boxH`
// and the next size to try when it doesn't.
export function fitStepFromLines(lines, boxW, boxH, currentPx, minPx = MIN_FIT_PX) {
  let contentH = 0
  let contentW = 0
  for (const l of lines || []) {
    contentH += l?.height || 0
    contentW = Math.max(contentW, l?.width || 0)
  }
  const overflowH = contentH > boxH + 0.5
  const overflowW = contentW > boxW + 0.5
  if (!overflowH && !overflowW) return { fits: true, nextPx: currentPx }
  return {
    fits: false,
    nextPx: nextFitPx(
      currentPx,
      overflowH ? boxH / contentH : 1,
      overflowW ? boxW / contentW : 1,
      minPx,
    ),
  }
}

// flex mappings — shared so the cast page and the previews line up.
export const FLEX_V = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
export const FLEX_H = { left: 'flex-start', center: 'center', right: 'flex-end' }
