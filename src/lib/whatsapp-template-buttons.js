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
          return `${where}'s URL uses a variable, which Meta accepts only with an example value — the template builder can't supply one yet, so use a fixed link.`
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
