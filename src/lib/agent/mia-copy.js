// MIAHATCH.2 — Mia's operator-editable customer copy for un1t.online studios.
//
// Each key is a settings.customer_agent field (settings-contract.js, null by
// default, inheritable from the organisation) with a code default here. The
// operator's value wins; with none, the default. An entry may carry a
// `without` branch for when one of its variables is empty (a studio with no
// booking link): then the operator's value is used only if it does not need
// that variable, else the `without` text. Whatever comes out has its em and
// en dashes scrubbed (Richard's rule for anything a customer reads).
//
// Pure and dependency-free apart from the default texts, so the settings
// editor can show the defaults as placeholders.
import { DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT, DEFAULT_CHAT_BOOKING_UNAVAILABLE_NO_LINK_TEXT } from './default-copy'

export const MIA_HATCH_COPY = Object.freeze({
  chat_booking_unavailable_text: Object.freeze({
    text: DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT,
    without: Object.freeze({ var: 'link', text: DEFAULT_CHAT_BOOKING_UNAVAILABLE_NO_LINK_TEXT }),
  }),
})

const isBlank = (v) => v === null || v === undefined || String(v).trim() === ''

/** Em and en dashes out: a dash between digits becomes a hyphen, any other a comma. Pure. */
function scrubDashes(text) {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
}

/** `{name}` placeholders filled from vars; one with no value leaves nothing behind. Pure. */
function fill(template, vars) {
  return template
    .replace(/\{(\w+)\}/g, (_m, name) => (isBlank(vars?.[name]) ? '' : String(vars[name]).trim()))
    .replace(/[ \t]+([,.!?:;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * The customer text for `key`: the operator's value (settings[key]) else the
 * code default, with `{var}`s filled from `vars`. When the entry's
 * `without.var` is empty in `vars`, the operator's value is used only if it
 * does not contain `{var}`, else `without.text`. An unknown key is ''. Pure.
 *
 * @param {string} key
 * @param {object|null} settings resolved Mia settings of the studio the text is about
 * @param {Record<string, string|null|undefined>} [vars]
 * @returns {string}
 */
export function renderMiaCopy(key, settings, vars = {}) {
  const entry = MIA_HATCH_COPY[key]
  if (!entry) return ''
  const raw = settings?.[key]
  const operator = typeof raw === 'string' ? raw.trim() : ''
  const without = entry.without
  let template
  if (without && isBlank(vars?.[without.var])) {
    template = operator && !operator.includes(`{${without.var}}`) ? operator : without.text
  } else {
    template = operator || entry.text
  }
  return scrubDashes(fill(template, vars))
}
