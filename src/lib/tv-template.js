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
  }
}

// flex mappings — shared so the cast page and the previews line up.
export const FLEX_V = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
export const FLEX_H = { left: 'flex-start', center: 'center', right: 'flex-end' }
