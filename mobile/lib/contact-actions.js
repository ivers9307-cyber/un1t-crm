// ROLEUI.1 — which action buttons the phone's contact screen shows.
//
// The routes those buttons call decide at the CONTACT's location:
//   Text / WhatsApp / Email → POST /api/contacts/[id]/sms | /whatsapp | /email
//   Cancel form             → POST /api/contacts/[id]/cancellation-form
//   Send kudos              → POST /api/contacts/[id]/kudos
// (the first four accept the web OR the mobile toggle there; kudos needs the
// web `consultations` permission there). The screen used to judge them with
// canMobile(profile, key, activeLocation), the ACTIVE studio's mobile toggle,
// so a button could show where the route refuses or hide where it accepts.
//
// The server already makes those decisions for this contact, with the helpers
// the routes use (src/lib/contact-page-gates.js), and returns them on the
// bundle the screen loads for its timeline:
//   GET /api/contacts/[id]/command-centre?scope=drawer → permissions:
//     { whatsapp, sms, email, kudos }
// This turns them into button flags. It never recomputes a permission:
// a second copy of the tier order on the phone is a rule that drifts.
//
// Fail closed: until the flags arrive, or if they could not be read, every
// action is hidden. The timeline shows its load error as text; there is
// no retry control, so recovery is leaving and returning to the screen
// (it re-fetches on focus) or posting a note.
// Pure: no react-native imports, so the repo's vitest collects the test.

/**
 * @param {{ whatsapp?: boolean, sms?: boolean, email?: boolean, kudos?: boolean } | null | undefined} permissions
 *   the bundle's `permissions`, or null before it has loaded
 * @param {{ phone?: string|null, wa_phone?: string|null, email?: string|null } | null | undefined} contact
 * @returns {{ sms: boolean, whatsapp: boolean, email: boolean,
 *   cancelFormEmail: boolean, cancelFormWhatsApp: boolean, cancelForm: boolean, kudos: boolean }}
 */
export function contactActionFlags(permissions, contact) {
  const p = permissions && typeof permissions === 'object' ? permissions : {}
  const c = contact || {}
  const sms = p.sms === true && Boolean(c.phone)
  const whatsapp = p.whatsapp === true && Boolean(c.wa_phone || c.phone)
  const email = p.email === true && Boolean(c.email)
  return {
    sms,
    whatsapp,
    email,
    cancelFormEmail: email,
    cancelFormWhatsApp: whatsapp,
    cancelForm: email || whatsapp,
    kudos: p.kudos === true,
  }
}
