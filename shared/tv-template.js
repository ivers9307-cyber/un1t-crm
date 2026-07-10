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
 *          plus a `styleRuns` property (TV-STYLE.1) — see below.
 */
export function resolveZone(zone = {}, value) {
  // Legacy plain-string value → treat as a text-only override.
  const v = value && typeof value === 'object' ? value : { text: value }

  // TV-TEMPLATE.5 — per-character colour overrides. Array of
  // { start, end, color }; any text not covered uses `color`.
  const colorRuns = Array.isArray(v.colorRuns)
    ? v.colorRuns
    : (Array.isArray(zone.colorRuns) ? zone.colorRuns : [])

  const out = {
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
    colorRuns,
  }

  // TV-STYLE.1 — unified style runs. Legacy colour runs are folded
  // in as colour-only runs so old pushes render unchanged, then the
  // value/zone styleRuns are overlaid on top (winning any overlap
  // per-property, via setRunStyle).
  const explicit = Array.isArray(v.styleRuns)
    ? v.styleRuns
    : (Array.isArray(zone.styleRuns) ? zone.styleRuns : [])
  let styleRuns = mergeStyleRuns(colorRuns)
  for (const r of explicit) {
    if (r && Number.isFinite(r.start) && Number.isFinite(r.end)) {
      styleRuns = setRunStyle(styleRuns, r.start, r.end, r)
    }
  }
  out.styleRuns = styleRuns

  return out
}

// ── Style runs (TV-STYLE.1, generalises TV-TEMPLATE.5) ──────────
//
// A zone's text is one string with one base style. To style part of
// it, editors record "style runs" — half-open character ranges
// { start, end, color?, fontSize?, bold?, underline? } — kept
// sorted, non-empty and non-overlapping; adjacent runs merge only
// when EVERY prop is strictly equal. Absent props fall back to the
// zone style; the base style fills any gap. The colour-only helpers
// below (TV-TEMPLATE.5) are thin wrappers over this engine.
//
// - fontSize: % of the base-image height, same unit as zone fontSize
// - bold: true → weight 800, false → weight 400, absent → zone weight
// - underline: absent/false → none
// - color: CSS hex, absent → zone color

const STYLE_KEYS = ['color', 'fontSize', 'bold', 'underline']

// Only the defined style props of a run (or a patch). An explicit
// false is a real value; undefined means "not set here".
function pickStyle(run) {
  const out = {}
  for (const k of STYLE_KEYS) {
    if (run && run[k] !== undefined) out[k] = run[k]
  }
  return out
}

function sameStyle(a, b) {
  return STYLE_KEYS.every(k => a[k] === b[k])
}

// Sort runs, drop empties (and prop-less runs), and merge touching
// runs whose style props are all strictly equal.
export function mergeStyleRuns(runs) {
  const sorted = (runs || [])
    .filter(r => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map(r => ({ start: Math.floor(r.start), end: Math.floor(r.end), ...pickStyle(r) }))
    .filter(r => STYLE_KEYS.some(k => r[k] !== undefined))
    .sort((a, b) => a.start - b.start)
  const out = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && sameStyle(last, r) && last.end >= r.start) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

// Overlay `patch` props on [start, end), PRESERVING any other props
// already present there (per-property merge, not replace). Patch
// props with value undefined are ignored; explicit false sticks.
export function setRunStyle(runs, start, end, patch) {
  const props = pickStyle(patch)
  if (!(end > start) || Object.keys(props).length === 0) return mergeStyleRuns(runs)
  const out = []
  let cursor = start
  for (const r of mergeStyleRuns(runs)) {
    if (r.end <= start || r.start >= end) { out.push(r); continue }
    const own = pickStyle(r)
    if (r.start < start) out.push({ start: r.start, end: start, ...own })
    const a = Math.max(r.start, start)
    const b = Math.min(r.end, end)
    if (a > cursor) out.push({ start: cursor, end: a, ...props })   // gap → patch only
    out.push({ start: a, end: b, ...own, ...props })
    cursor = b
    if (r.end > end) out.push({ start: end, end: r.end, ...own })
  }
  if (cursor < end) out.push({ start: cursor, end, ...props })
  return mergeStyleRuns(out)
}

// Remove the listed prop keys (all of them when `keys` is omitted)
// from [start, end). Chars left with no props drop out of the runs.
export function clearRunStyle(runs, start, end, keys) {
  if (!(end > start)) return mergeStyleRuns(runs)
  const clear = Array.isArray(keys) && keys.length ? keys : STYLE_KEYS
  const out = []
  for (const r of mergeStyleRuns(runs)) {
    if (r.end <= start || r.start >= end) { out.push(r); continue }
    const own = pickStyle(r)
    const kept = {}
    for (const k of STYLE_KEYS) {
      if (own[k] !== undefined && !clear.includes(k)) kept[k] = own[k]
    }
    if (r.start < start) out.push({ start: r.start, end: start, ...own })
    if (Object.keys(kept).length) {
      out.push({ start: Math.max(r.start, start), end: Math.min(r.end, end), ...kept })
    }
    if (r.end > end) out.push({ start: end, end: r.end, ...own })
  }
  return mergeStyleRuns(out)
}

// The props that hold the SAME value across every char of
// [start, end) — editors use this to show active states and decide
// toggle direction. Uniformly-absent props are simply omitted; a
// prop set on only part of the range is not uniform.
export function rangeStyle(runs, start, end) {
  if (!(end > start)) return {}
  // Slice the range into covered pieces + gaps, then keep only the
  // props with one value across all pieces.
  const pieces = []
  let cursor = start
  for (const r of mergeStyleRuns(runs)) {
    if (r.end <= start || r.start >= end) continue
    const a = Math.max(r.start, start)
    if (a > cursor) pieces.push({})
    pieces.push(pickStyle(r))
    cursor = Math.min(r.end, end)
  }
  if (cursor < end) pieces.push({})
  const out = {}
  for (const k of STYLE_KEYS) {
    const v = pieces[0][k]
    if (v !== undefined && pieces.every(p => p[k] === v)) out[k] = v
  }
  return out
}

// {start, end} of the line containing `index` (clamped into
// [0, text.length]); end excludes the trailing \n. An index sitting
// exactly on a line's end belongs to THAT line; an index right
// after a \n belongs to the next line. Cursor-→-line targeting for
// the editors.
export function lineRangeAt(text, index) {
  const str = text == null ? '' : String(text)
  const raw = Number.isFinite(index) ? Math.floor(index) : 0
  const i = Math.max(0, Math.min(raw, str.length))
  const start = i > 0 ? str.lastIndexOf('\n', i - 1) + 1 : 0
  const nl = str.indexOf('\n', start)
  return { start, end: nl === -1 ? str.length : nl }
}

// ── Colour-only wrappers (TV-TEMPLATE.5) ────────────────────────
//
// Kept for the current colour-paint UI + old call sites; each is a
// thin wrapper over the style-run engine above with identical
// behaviour for colour-only runs.

// Sort runs, drop empties, and merge touching runs of equal colour.
export function mergeRuns(runs) {
  return mergeStyleRuns(runs)
}

// Paint [start, end) with `color` (replacing any colour there).
export function setRunColor(runs, start, end, color) {
  return setRunStyle(runs, start, end, { color })
}

// Revert [start, end) to the base colour (remove colour there).
export function clearRunColor(runs, start, end) {
  return clearRunStyle(runs, start, end, ['color'])
}

// Remap run offsets after the text is edited, by diffing the old
// and new strings (common prefix / suffix). Keeps every style prop
// roughly attached to the same words through inserts + deletes.
export function shiftRuns(runs, oldText, newText) {
  const o = oldText || '', n = newText || ''
  if (o === n) return mergeStyleRuns(runs)
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
  return mergeStyleRuns((runs || []).map(r => ({
    start: remap(r.start), end: remap(r.end), ...pickStyle(r),
  })))
}

// Split `text` into contiguous render segments, splitting wherever
// ANY style prop changes. Every segment carries a resolved color
// (base fallback); fontSize/bold/underline appear only when set.
export function textSegments(text, runs, baseColor) {
  const str = text == null ? '' : String(text)
  const base = baseColor || '#FFFFFF'
  const n = str.length
  if (n === 0) return [{ text: '', color: base }]
  const NONE = {}
  const styles = new Array(n).fill(NONE)
  for (const r of runs || []) {
    if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end)) continue
    const a = Math.max(0, Math.floor(r.start))
    const b = Math.min(n, Math.floor(r.end))
    if (b <= a) continue
    const style = pickStyle(r)
    for (let i = a; i < b; i++) styles[i] = style
  }
  const segs = []
  let start = 0
  for (let i = 1; i <= n; i++) {
    if (i === n || !sameStyle(styles[i], styles[start])) {
      const st = styles[start]
      const seg = { text: str.slice(start, i), color: st.color || base }
      if (st.fontSize !== undefined) seg.fontSize = st.fontSize
      if (st.bold !== undefined) seg.bold = st.bold
      if (st.underline !== undefined) seg.underline = st.underline
      segs.push(seg)
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
