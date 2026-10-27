// ROLEUI.1 — which action buttons the phone's contact screen shows.
//
// The routes those buttons call decide at the CONTACT's location:
//   WhatsApp / Email        → POST /api/contacts/[id]/whatsapp | /email
//   (Text via /sms left with Twilio in TWILIO-RETIRE.1)
//   Cancel form             → POST /api/contacts/[id]/cancellation-form
//   Send kudos              → POST /api/contacts/[id]/kudos
//   Note composer           → POST /api/contacts/[id]/notes (CARDLENS-M.4)
// (the first three accept the web OR the mobile toggle there; kudos needs the
// web `consultations` permission there). The screen used to judge them with
// canMobile(profile, key, activeLocation), the ACTIVE studio's mobile toggle,
// so a button could show where the route refuses or hide where it accepts.
//
// The server already makes those decisions for this contact, with the helpers
// the routes use (src/lib/contact-page-gates.js), and returns them on the
// bundle the screen loads for its timeline:
//   GET /api/contacts/[id]/command-centre?scope=drawer → permissions:
//     { whatsapp, email, kudos, note }
// This turns them into button flags. It never recomputes a permission:
// a second copy of the tier order on the phone is a rule that drifts.
//
// Fail closed: until the flags arrive, or if they could not be read, every
// action is hidden. The timeline shows its load error as text; there is
// no retry control, so recovery is leaving and returning to the screen
// (it re-fetches on focus) or posting a note.
// `note` (CARDLENS-M.4) came later: a server older than this app sends no
// `note` key, and then the composer shows as it always did (the route still
// refuses a post it would not accept). An explicit false hides it.
// CARDLENS-M.8 — since M-B the bundle judges whatsapp, email, note and `task`
// at the screen's ACTING studio, and sends `cancel_form`, judged at the
// primary studio (the web keeps the form there), so the cancel form no
// longer follows the acting studio's channel flags. An older server sends
// neither key: no Task button, and the cancel form follows the channels as
// before.
// Pure: no react-native imports, so the repo's vitest collects the test.

/**
 * @param {{ whatsapp?: boolean, email?: boolean, kudos?: boolean, note?: boolean,
 *   task?: boolean, cancel_form?: boolean } | null | undefined} permissions
 *   the bundle's `permissions`, or null before it has loaded
 * @param {{ phone?: string|null, wa_phone?: string|null, email?: string|null } | null | undefined} contact
 * @returns {{ whatsapp: boolean, email: boolean,
 *   cancelFormEmail: boolean, cancelFormWhatsApp: boolean, cancelForm: boolean, kudos: boolean,
 *   note: boolean, task: boolean }}
 */
export function contactActionFlags(permissions, contact) {
  const loaded = Boolean(permissions && typeof permissions === 'object')
  const p = loaded ? permissions : {}
  const c = contact || {}
  const whatsapp = p.whatsapp === true && Boolean(c.wa_phone || c.phone)
  const email = p.email === true && Boolean(c.email)
  const hasEmail = Boolean(c.email)
  const hasPhone = Boolean(c.wa_phone || c.phone)
  const formAllowed = 'cancel_form' in p ? p.cancel_form === true : null
  const cancelFormEmail = formAllowed === null ? email : formAllowed && hasEmail
  const cancelFormWhatsApp = formAllowed === null ? whatsapp : formAllowed && hasPhone
  return {
    whatsapp,
    email,
    cancelFormEmail,
    cancelFormWhatsApp,
    cancelForm: cancelFormEmail || cancelFormWhatsApp,
    kudos: p.kudos === true,
    note: loaded && ('note' in p ? p.note === true : true),
    task: p.task === true,
  }
}
