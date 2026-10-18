// UN1TWRITE.17/18 — the class_funnel block's un1t.online copy.
//
// Pure: no DB, no env, no server import (the landing-page editor and the
// ClassFunnel read it in the browser). Every string a customer reads on the
// un1t.online path is an operator-editable class_funnel field, with the
// default below when the field is blank or absent (CLAUDE.md: customer copy
// is operator-editable). No em-dashes in any default, never a capacity word,
// never the gym's brand name.
//
// Placeholders are single-brace: {studio_name} in the terms label, plus
// {terms} and {waiver}, which render as the two document links.

export const DEFAULT_UN1T_FUNNEL_COPY = Object.freeze({
  terms_label: "I accept {studio_name}'s {terms} and {waiver}",
  terms_link_label: 'terms and conditions',
  waiver_link_label: 'liability waiver',
  terms_required_message: 'Please tick to accept the terms and waiver.',
  legal_unavailable_message: 'This document could not be loaded right now. Please try again shortly.',
})

export const UN1T_FUNNEL_COPY_KEYS = Object.freeze(Object.keys(DEFAULT_UN1T_FUNNEL_COPY))

function classFunnelBlock(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  return list.find((b) => b && typeof b === 'object' && b.type === 'class_funnel') || null
}

/** The block's un1t.online copy, each blank field falling back to its default. */
export function un1tFunnelCopyFromBlocks(blocks) {
  const cf = classFunnelBlock(blocks)
  const out = {}
  for (const key of UN1T_FUNNEL_COPY_KEYS) {
    const v = cf?.[key]
    out[key] = typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_UN1T_FUNNEL_COPY[key]
  }
  return out
}

/** Em and en dashes out of customer copy (the same rule as the agent's scrub). */
export function stripDashes(s) {
  return String(s ?? '')
    .replace(/\s*[—–]\s+/g, ', ')
    .replace(/\s+[—–]\s*/g, ', ')
    .replace(/[—–]/g, '-')
}

/** Fill {placeholders} (unknown ones render empty) and strip dashes. */
export function fillCopy(template, vars = {}) {
  const filled = String(template ?? '').replace(/\{([a-z_]+)\}/g, (_, key) => {
    const v = vars[key]
    return v == null ? '' : String(v)
  })
  return stripDashes(filled).replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * The terms label as segments the ClassFunnel renders: plain text, and the two
 * links where {terms} and {waiver} stand. A label missing either gets that
 * link appended after it, so both documents are always one tap away.
 * @returns {{ text: string, link?: 'terms'|'waiver' }[]}
 */
export function termsLabelSegments(copy, { studioName = '' } = {}) {
  const c = { ...DEFAULT_UN1T_FUNNEL_COPY, ...(copy || {}) }
  let label = String(c.terms_label ?? '')
  if (!label.includes('{terms}')) label += ' {terms}'
  if (!label.includes('{waiver}')) label += ' {waiver}'
  const out = []
  for (const piece of label.split(/(\{terms\}|\{waiver\})/)) {
    if (piece === '{terms}') out.push({ text: stripDashes(c.terms_link_label), link: 'terms' })
    else if (piece === '{waiver}') out.push({ text: stripDashes(c.waiver_link_label), link: 'waiver' })
    // Plain text keeps its spaces: they sit between the words and the links.
    else if (piece) out.push({ text: stripDashes(piece.replace(/\{studio_name\}/g, studioName).replace(/\{[a-z_]+\}/g, '')) })
  }
  return out.filter((s) => s.text !== '')
}

/** The same label as one line of plain text (a WhatsApp Flow label carries no links). */
export function termsLabelText(copy, { studioName = '' } = {}) {
  return termsLabelSegments(copy, { studioName }).map((s) => s.text).join('').replace(/[ \t]{2,}/g, ' ').trim()
}
