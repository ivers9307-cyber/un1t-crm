// Meta's message-template button rules, enforced BEFORE the submit round-trip.
// Break any of them and the whole template is refused with a generic code-100
// "Invalid parameter" (subcode 2388060, "Button format is incorrect") — which
// tells the operator nothing about which button, or what in it. Catching it here
// names the button and the offending character instead.
//
// Rules per Meta's message-template components reference: 10 buttons total,
// max 2 URL, max 1 phone-number; labels are 25 characters of plain text.

const VARIABLE = /\{\{\s*[^{}]+\s*\}\}/
const NEWLINE = /[\r\n]/
// Extended_Pictographic is emoji proper — it deliberately does NOT match '*' or
// digits, which carry the Emoji property but are legal button characters.
const EMOJI = /\p{Extended_Pictographic}/u
// WhatsApp's markdown delimiters. Meta calls these "formatting characters" and
// refuses them in a button label even unpaired.
const FORMATTING = /[*_~`]/

export const MAX_BUTTON_TEXT = 25
export const MAX_BUTTONS = 10
export const MAX_URL_BUTTONS = 2
export const MAX_PHONE_BUTTONS = 1

const KNOWN_TYPES = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'FLOW', 'COPY_CODE']

/** Meta's per-button `example`, which arrives as an array but is written as a scalar. */
function exampleValues(btn) {
  const raw = Array.isArray(btn?.example) ? btn.example : [btn?.example]
  return raw.filter((v) => String(v ?? '').trim())
}

/**
 * First rule a button list breaks, as a user-facing sentence, or null when the
 * list is one Meta will accept. Buttons are named by 1-based position so the
 * message lines up with the editor.
 *
 * `ignoreEmptyLabels` skips half-built buttons entirely — for the editor's live
 * hint, where a just-added button is empty by definition and scolding someone
 * mid-keystroke is noise. Submit paths leave it off.
 */
export function templateButtonsError(buttons = [], { ignoreEmptyLabels = false } = {}) {
  const list = Array.isArray(buttons) ? buttons : []
  if (list.length === 0) return null
  if (list.length > MAX_BUTTONS) return `A template can have at most ${MAX_BUTTONS} buttons (this one has ${list.length}).`

  for (const [i, btn] of list.entries()) {
    const where = `Button ${i + 1}`
    const type = String(btn?.type || '').toUpperCase()
    if (!KNOWN_TYPES.includes(type)) return `${where} has an unsupported type (${btn?.type || 'none'}).`

    const text = typeof btn?.text === 'string' ? btn.text : ''
    if (!text.trim()) {
      if (ignoreEmptyLabels) continue
      return `${where} needs label text.`
    }
    if (text.length > MAX_BUTTON_TEXT) return `${where}'s label must be ${MAX_BUTTON_TEXT} characters or fewer (it is ${text.length}).`
    if (VARIABLE.test(text)) return `${where}'s label can't contain a variable like {{1}} — Meta only allows plain text on buttons.`
    if (NEWLINE.test(text)) return `${where}'s label can't contain a line break.`
    if (EMOJI.test(text)) return `${where}'s label can't contain emoji.`
    if (FORMATTING.test(text)) return `${where}'s label can't contain formatting characters (* _ ~ \`).`

    if (type === 'URL') {
      const url = typeof btn?.url === 'string' ? btn.url.trim() : ''
      if (!url) return `${where} needs a URL.`
      if (!/^https?:\/\//i.test(url)) return `${where}'s URL must start with https:// (or http://).`
      if (VARIABLE.test(url)) {
        // Meta allows exactly one variable, at the very end of the link, and
        // only alongside an example value. Templates synced back from Meta
        // already carry that example — the builder can't yet author one.
        if ((url.match(/\{\{\s*[^{}]+\s*\}\}/g) || []).length > 1) return `${where}'s URL can contain only one variable.`
        if (!/\{\{\s*[^{}]+\s*\}\}$/.test(url)) return `${where}'s URL can only use a variable at the very end of the link.`
        if (!exampleValues(btn).length) {
          return `${where}'s link ends in a variable, so Meta needs a sample value for it — fill in the sample field under the button.`
        }
      }
    }

    if (type === 'PHONE_NUMBER' && !String(btn?.phone_number || '').trim()) {
      return `${where} needs a phone number.`
    }

    if (type === 'FLOW') {
      if (!String(btn?.flow_id || '').trim()) return `${where} needs a Flow ID.`
      if (!String(btn?.navigate_screen || '').trim()) return `${where} needs an entry screen.`
    }

    if (type === 'COPY_CODE' && !String(btn?.example || '').trim()) {
      return `${where} needs an example coupon code.`
    }
  }

  const count = (type) => list.filter((b) => String(b?.type || '').toUpperCase() === type).length
  if (count('URL') > MAX_URL_BUTTONS) return `A template can have at most two URL buttons (this one has ${count('URL')}).`
  if (count('PHONE_NUMBER') > MAX_PHONE_BUTTONS) return `A template can have only one phone-number button (this one has ${count('PHONE_NUMBER')}).`

  return null
}

// What Meta accepts on each button type. The editor mutates one button object
// in place as the operator switches its type, so a URL typed before switching
// to QUICK_REPLY would otherwise ride along to Meta as a stray field.
const FIELDS_BY_TYPE = {
  QUICK_REPLY: ['type', 'text'],
  URL: ['type', 'text', 'url', 'example'],
  PHONE_NUMBER: ['type', 'text', 'phone_number'],
  FLOW: ['type', 'text', 'flow_id', 'navigate_screen', 'flow_action'],
  COPY_CODE: ['type', 'text', 'example'],
}

/**
 * Drop every field that doesn't belong to the button's type, and carry `example`
 * on a URL button ONLY when its link actually ends in a variable — the sample
 * lives on the button object so it round-trips through a synced template, which
 * means a stale one outlives the operator deleting the variable from the link.
 */
export function normalizeButtonsForMeta(buttons = []) {
  const list = Array.isArray(buttons) ? buttons : []
  return list.map((btn) => {
    const type = String(btn?.type || '').toUpperCase()
    const allowed = FIELDS_BY_TYPE[type]
    if (!allowed) return btn      // unknown type — the validator rejects it by name
    const out = {}
    for (const key of allowed) {
      if (key === 'example') continue
      if (btn?.[key] !== undefined) out[key] = btn[key]
    }
    const wantsExample = type === 'COPY_CODE' || (type === 'URL' && VARIABLE.test(String(btn?.url || '')))
    const example = exampleValues(btn)
    if (wantsExample && example.length) out.example = example
    return out
  })
}

/**
 * The variable-mapping key that carries a dynamic URL button's per-send value.
 * Deliberately not a number: Meta numbers a button's variables independently of
 * the body's, so a bare "1" would collide with the body's {{1}}.
 */
export const URL_BUTTON_MAPPING_KEY = 'url_button'

/** Buttons out of a Meta components array (never null). */
function buttonsOf(components) {
  const list = Array.isArray(components) ? components : []
  const comp = list.find((c) => String(c?.type || '').toUpperCase() === 'BUTTONS')
  return Array.isArray(comp?.buttons) ? comp.buttons : []
}

/**
 * Position of the URL button whose link carries a variable, or -1. The position
 * is the button's index inside BUTTONS — which is exactly the `index` Meta wants
 * on the per-send button parameter.
 */
export function dynamicUrlButtonIndex(components) {
  return buttonsOf(components).findIndex(
    (b) => String(b?.type || '').toUpperCase() === 'URL' && VARIABLE.test(String(b?.url || ''))
  )
}

// The two block messages differ by ONE clause — what the operator is about to
// do, and where they do it. Everything either side of that is shared, so it is
// written once: a copy edit to the diagnosis or to the consequence would
// otherwise have to be made twice, and the second one is the one that gets
// missed. `action` is the only variable part.
const blockSentence = (label, action) =>
  `The "${label}" button's link ends in a variable with no value set. ${action} — Meta rejects every message without it.`

/** The button's label, or a positional fallback. */
function urlButtonLabel(components, idx) {
  return buttonsOf(components)[idx]?.text || `button ${idx + 1}`
}

/** Shared gate: the index of a dynamic URL button with nothing mapped, or -1. */
function unmappedUrlButtonIndex(template, variableMapping) {
  const idx = dynamicUrlButtonIndex(template?.components)
  if (idx < 0) return -1
  if (String(variableMapping?.[URL_BUTTON_MAPPING_KEY] ?? '').trim()) return -1
  return idx
}

/**
 * Why this template must not be sent yet, or null. A dynamic URL button needs a
 * per-send value: without it Meta rejects every single message with 132012, so
 * the blast fails one recipient at a time (how the video-header bug played out
 * on 2026-06-11). Refuse the whole send instead, naming the button.
 */
export function urlButtonSendBlock(template, variableMapping) {
  const idx = unmappedUrlButtonIndex(template, variableMapping)
  if (idx < 0) return null
  return blockSentence(urlButtonLabel(template.components, idx), 'Set the link value on this send before sending')
}

/**
 * SEQ-URLBUTTON.1 — the same block, worded for a sequence STEP.
 *
 * Identical detection, different register: a broadcast is SENT (now, to a list),
 * a step is PUBLISHED (and fires weeks later, one contact at a time). Telling an
 * operator in the flow builder to fix something "on this send before sending"
 * points at a thing that isn't in front of them. Deliberately a second function
 * rather than a parameter on urlButtonSendBlock: the send path's sentence is
 * quoted in its own tests and in the broadcast UI, and must not drift.
 */
export function urlButtonStepBlock(template, variableMapping) {
  const idx = unmappedUrlButtonIndex(template, variableMapping)
  if (idx < 0) return null
  return blockSentence(urlButtonLabel(template.components, idx), 'Set the link value on this step before publishing')
}

/**
 * Same check against a full Meta components array — the shape the API routes
 * receive, so a direct API caller hits the same wall as the editor.
 */
export function componentsButtonsError(components = []) {
  const list = Array.isArray(components) ? components : []
  const comp = list.find((c) => String(c?.type || '').toUpperCase() === 'BUTTONS')
  if (!comp) return null
  if (!Array.isArray(comp.buttons) || comp.buttons.length === 0) {
    return 'The buttons section is empty — remove it or add a button.'
  }
  return templateButtonsError(comp.buttons)
}
