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

export const DEFAULT_FUNNEL_TERMS_COPY = Object.freeze({
  terms_label: "I accept {studio_name}'s {terms} and {waiver}",
  terms_link_label: 'terms and conditions',
  waiver_link_label: 'liability waiver',
  terms_required_message: 'Please tick to accept the terms and waiver.',
  legal_unavailable_message: 'This document could not be loaded right now. Please try again shortly.',
})

export const UN1T_FUNNEL_COPY_KEYS = Object.freeze(Object.keys(DEFAULT_FUNNEL_TERMS_COPY))

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
    out[key] = typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_FUNNEL_TERMS_COPY[key]
  }
  return out
}

/**
 * Em and en dashes out of customer copy: the same rule as stripEmDashes in
 * agent/core.js, copied because this module runs in the browser and that one
 * pulls in the agent's prompt. un1t-online-funnel-copy.test.js pins the two
 * to the same output.
 */
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
  const c = { ...DEFAULT_FUNNEL_TERMS_COPY, ...(copy || {}) }
  // A studio with no name still reads as a sentence.
  const name = String(studioName || '').trim() || 'the studio'
  let label = String(c.terms_label ?? '')
  if (!label.includes('{terms}')) label += ' {terms}'
  if (!label.includes('{waiver}')) label += ' {waiver}'
  const out = []
  for (const piece of label.split(/(\{terms\}|\{waiver\})/)) {
    if (piece === '{terms}') out.push({ text: stripDashes(c.terms_link_label), link: 'terms' })
    else if (piece === '{waiver}') out.push({ text: stripDashes(c.waiver_link_label), link: 'waiver' })
    // Plain text keeps its spaces: they sit between the words and the links.
    else if (piece) out.push({ text: stripDashes(piece.replace(/\{studio_name\}/g, name).replace(/\{[a-z_]+\}/g, '')) })
  }
  return out.filter((s) => s.text !== '')
}

// UN1TWRITE.21 — the funnel's two customer emails (spec D 6.5), edited on
// the class_funnel block beside the confirmation email. Placeholders:
// {first_name} {class_name} {class_time} {studio_name} {address} (account)
// and {options} (trial used: the studio's offer list, never capacity).
export const DEFAULT_FUNNEL_EMAIL_COPY = Object.freeze({
  account_email_subject: 'You are booked in at {studio_name}',
  account_email_body: 'Hi {first_name}, you are booked in for {class_name} on {class_time} at {studio_name}. {address} We have set up your account on the un1t.online app so you can see and manage your bookings. In a minute you will get an email from un1t.online with a code to set your password. Use it to sign in to the app. Arrive about 10 minutes early and a coach will meet you. See you then, {studio_name}',
  trial_used_email_subject: 'About your class at {studio_name}',
  trial_used_email_body: 'Hi {first_name}, thanks for choosing {class_name} on {class_time}. Our records show you have already had the free trial at {studio_name}, so we have not booked this class yet. To book it you can pick one of these: {options} Just reply to this email with the one you want and we will send you a secure payment link. Once you have paid, we will book you in. See you soon, {studio_name}',
})
/** What {options} says when the studio has no offer list. */
export const DEFAULT_TRIAL_USED_OPTIONS = 'a class pack or a membership'

/** The block's email copy, each blank field falling back to its default. */
export function un1tFunnelEmailCopyFromBlocks(blocks) {
  const cf = classFunnelBlock(blocks)
  const out = {}
  for (const key of Object.keys(DEFAULT_FUNNEL_EMAIL_COPY)) {
    const v = cf?.[key]
    out[key] = typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_FUNNEL_EMAIL_COPY[key]
  }
  return out
}

const LEGAL_DOCS = Object.freeze(['terms', 'waiver'])

/** The public page for a studio's document (/legal/un1t/<public_path>/<doc>). */
export function legalDocPathFor(publicPath, doc) {
  if (!LEGAL_DOCS.includes(doc)) throw new TypeError(`legalDocPathFor: unknown document '${doc}'`)
  return `/legal/un1t/${publicPath}/${doc}`
}

/**
 * What the website funnel needs to show the required tick: the label (studio
 * name filled, {terms}/{waiver} kept for the links), the link labels, the
 * message and the two page urls. One builder for the class list and the
 * booking route's 400, so the two can never disagree on the wording.
 */
export function un1tTermsPayload({ blocks, studioName, publicPath }) {
  const copy = un1tFunnelCopyFromBlocks(blocks)
  return {
    required: true,
    label: stripDashes(copy.terms_label.replace(/\{studio_name\}/g, String(studioName || '').trim() || 'the studio')),
    terms_link_label: stripDashes(copy.terms_link_label),
    waiver_link_label: stripDashes(copy.waiver_link_label),
    required_message: stripDashes(copy.terms_required_message),
    terms_url: legalDocPathFor(publicPath, 'terms'),
    waiver_url: legalDocPathFor(publicPath, 'waiver'),
  }
}

/** The same label as one line of plain text (a WhatsApp Flow label carries no links). */
export function termsLabelText(copy, { studioName = '' } = {}) {
  return termsLabelSegments(copy, { studioName }).map((s) => s.text).join('').replace(/[ \t]{2,}/g, ' ').trim()
}
