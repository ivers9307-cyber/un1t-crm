// ROLESWEEP.1c — the contact page's server-side DATA gates, judged at the
// CONTACT's location.
//
// The contact page (src/app/(sales)/contacts/[id]/page.js) renders through
// createServerClient() (service role, so RLS does not bind it): these checks
// ARE the access gate for what it loads. hasPermission(user, …) resolves at
// the ACTIVE studio, so a caller whose consultations toggle is on at their
// active studio and off at the contact's would have had that contact's
// consultations, goals, photos and scans loaded into the page. Every decision
// here is made at the contact's location instead.
import { hasPermission, hasPermissionForLocation, hasMobilePermissionForLocation } from './permissions'
import { hasRoleAtLocation } from './role-at-location'
import { ADMIN_ROLES, MANAGER_ROLES } from './schemas'

/**
 * May the page load this contact's consultations, coaching goals,
 * consultation photos and InBody scans? The `consultations` permission at the
 * contact's location, the same decision the /api/contacts/[id]/consultations
 * family makes.
 *
 * @param {object|null} user        getCurrentUser() result
 * @param {string|null} locationId  the contact's location_id
 * @returns {boolean}
 */
export function canLoadContactConsultations(user, locationId) {
  return hasPermissionForLocation(user, locationId, 'consultations')
}

/**
 * The composer's channel flags for a contact: WhatsApp and email, each
 * the web OR the mobile toggle at the contact's location. That is exactly the
 * decision the send routes (/api/contacts/[id]/whatsapp, /email) make,
 * so a composer never offers a channel the send route would refuse, nor hides
 * one it would accept. The contact page and the pipeline drawer
 * (/api/contacts/[id]/command-centre?scope=drawer) both read these; `whatsapp`
 * also gates the page's and the drawer's WhatsApp template read.
 *
 * @param {object|null} user
 * @param {string|null} locationId  the contact's location_id
 * @returns {{ whatsapp: boolean, email: boolean }}
 */
export function contactChannelFlags(user, locationId) {
  const at = (key) =>
    hasPermissionForLocation(user, locationId, key) || hasMobilePermissionForLocation(user, locationId, key)
  return { whatsapp: at('whatsapp'), email: at('email') }
}

// ── ROLEUI.1 — the contact page's action BUTTONS ──────────────────────────
// Each helper below is the decision of the route its button calls, made the
// way that route makes it: membership of the contact's location first (masters
// skip it), then the role AT the contact's location, never user.role (the
// ACTIVE studio's role). The role tuples are copied from the routes, which do
// not export them; src/lib/contact-page-gates.test.js runs each helper over the
// SAME case table as the route's own sweep test, so a drift in either shows.

// invite-app: ALLOWED_INVITE_ROLES in src/app/api/contacts/[id]/invite-app/route.js
const INVITE_ROLES = Object.freeze(['owner', 'manager'])
// devices: WRITE_ROLES in src/app/api/contacts/[id]/devices/route.js and
// devices/[deviceId]/route.js (masters pass on isMaster, before the role)
const DEVICE_WRITE_ROLES = Object.freeze(['owner', 'manager', 'head_coach'])
// link-account and the member half of admin/password-override: owner only
const OWNER_ONLY = Object.freeze(['owner'])

/**
 * A member of `locationId` (masters are members everywhere) who holds one of
 * `roles` there. hasRoleAtLocation answers false for a missing location, a
 * master included, which is what the routes without an isMaster bypass do.
 */
function memberWithRole(user, locationId, roles) {
  if (!user || !locationId) return false
  if (!user.isMaster && !(user.locations || []).some((l) => l?.id === locationId)) return false
  return hasRoleAtLocation(user, locationId, roles)
}

/**
 * PUT /api/contacts/[id] (cookie path), DELETE /api/contacts/[id] and
 * GET /api/contacts/[id]/impact: MANAGER_ROLES at the contact's location. The
 * automations-exempt toggle (a PUT) and the Delete button (impact, then
 * DELETE) read it. POST /api/contacts makes the same decision at the location
 * the contact is created at, so /contacts/new asks it of the active studio.
 *
 * @param {object|null} user
 * @param {string|null} locationId
 * @returns {boolean}
 */
export function canWriteContact(user, locationId) {
  return memberWithRole(user, locationId, MANAGER_ROLES)
}

/**
 * The Edit link and the /contacts/[id]/edit page: the PUT's decision plus the
 * `contacts` permission, both at the contact's location. The page has always
 * required `contacts` on top of the role (a feature gate the PUT does not
 * repeat); judging both here keeps the link and the page in step.
 */
export function canOpenContactEditor(user, locationId) {
  return canWriteContact(user, locationId) && hasPermissionForLocation(user, locationId, 'contacts')
}

/** PATCH /api/contacts/[id]/marketing-preferences: master, or ADMIN_ROLES at the contact. */
export function canEditMarketingPreferences(user, locationId) {
  return Boolean(user?.isMaster) || memberWithRole(user, locationId, ADMIN_ROLES)
}

/** POST /api/contacts/[id]/invite-app: an email on file, and master or owner/manager at the contact. */
export function canInviteToApp(user, contact) {
  if (!contact?.email) return false
  return Boolean(user?.isMaster) || memberWithRole(user, contact.location_id, INVITE_ROLES)
}

/** POST …/devices and DELETE/PATCH …/devices/[deviceId]: master, or owner/manager/head coach at the contact. */
export function canEditContactDevices(user, locationId) {
  return Boolean(user?.isMaster) || memberWithRole(user, locationId, DEVICE_WRITE_ROLES)
}

/** GET/POST/DELETE /api/contacts/[id]/link-account: master, or owner at the contact. */
export function canLinkAppAccount(user, locationId) {
  return Boolean(user?.isMaster) || memberWithRole(user, locationId, OWNER_ONLY)
}

/**
 * POST /api/admin/password-override for a member: the contact has a CRM login
 * (contacts.user_id), and the caller is a master or an owner at the contact.
 */
export function canOverrideMemberPassword(user, contact) {
  if (!contact?.user_id) return false
  return Boolean(user?.isMaster) || memberWithRole(user, contact.location_id, OWNER_ONLY)
}

/**
 * Every action flag the contact page hands its components, judged at the
 * contact's location.
 *
 * @param {object|null} user     getCurrentUser() result
 * @param {object|null} contact  the contacts row (location_id, email, user_id)
 */
export function contactActionGates(user, contact) {
  const loc = contact?.location_id || null
  return {
    canToggleExempt: canWriteContact(user, loc),
    canEditPrefs: canEditMarketingPreferences(user, loc),
    admin: {
      canPasswordOverride: canOverrideMemberPassword(user, contact),
      canEdit: canOpenContactEditor(user, loc),
      canDelete: canWriteContact(user, loc),
      canInvite: canInviteToApp(user, contact),
      hasUserAccount: Boolean(contact?.user_id),
      canEditDevices: canEditContactDevices(user, loc),
      canLinkAccount: canLinkAppAccount(user, loc),
    },
  }
}

// ── ROLEUI.2 — the buttons that had NO gate ───────────────────────────────
// Rendered for every viewer until now and refused by their routes for anyone
// the route's rule excludes, a crossover viewer included (canViewContact opens
// a contact with a deal at the caller's studio to someone who belongs to none
// of the contact's). Each helper is the route's decision at the contact's
// location; src/lib/contact-page-gates-roleui2.test.js runs each over the
// route's own sweep table.

/**
 * A member of the contact's studio (masters are members everywhere). The
 * whole rule for: the Task/Activity writes (browser insert; activities RLS,
 * mig 219, needs a profile_locations row there), the Book card
 * (/api/bookings/create, /api/glofox/classes/*: assertLocationAccess) and the
 * consent history card (/api/contacts/[id]/consent-log: assertLocationAccessOr404).
 * Membership only, never a role or key: those paths judge nothing more, and
 * the RLS half resolves mobile toggles in SQL without role templates, so a JS
 * permission gate on Task could hide a write RLS would accept.
 */
export function isMemberOfContactStudio(user, locationId) {
  if (!user || !locationId) return false
  return Boolean(user.isMaster) || (user.locations || []).some((l) => l?.id === locationId)
}

/** POST /api/contacts/[id]/pipeline-status (the Cold item): `pipeline` at the contact. */
export function canSetPipelineStatus(user, locationId) {
  return hasPermissionForLocation(user, locationId, 'pipeline')
}

/** POST /api/contacts/[id]/notes (the Note button): `contacts` at the contact. */
export function canAddContactNote(user, locationId) {
  return hasPermissionForLocation(user, locationId, 'contacts')
}

/**
 * The Sequence buttons: the picker lists sequences AT the contact's location
 * (GET /api/sequences: email or whatsapp there) and enrols through
 * POST /api/sequences/[id]/enrol (`email` at the sequence's location), so the
 * button works exactly when the caller holds `email` at the contact's.
 */
export function canEnrolContactInSequence(user, locationId) {
  return hasPermissionForLocation(user, locationId, 'email')
}

/** GET/POST /api/contacts/[id]/cancellation-form: email OR whatsapp, web OR mobile, at the contact. */
export function canSendCancellationForm(user, locationId) {
  const f = contactChannelFlags(user, locationId)
  return f.whatsapp || f.email
}

/** POST/DELETE /api/contacts/[id]/link (Linked accounts): `contact_linking` at the contact. */
export function canLinkContacts(user, locationId) {
  return hasPermissionForLocation(user, locationId, 'contact_linking')
}

/**
 * POST /api/whatsapp/conversations/start. That route still judges `whatsapp`
 * at the ACTIVE studio (requireInboxPermission; moving it belongs to the inbox
 * follow-up, C37 INBOXLOC.1) and membership at the contact. The button shows
 * only where the route acts AND the contact's studio grants whatsapp, so it
 * never offers what the route refuses nor more than the contact's studio
 * allows. When the route moves, drop the hasPermission half.
 */
export function canStartWhatsAppThread(user, locationId) {
  return isMemberOfContactStudio(user, locationId)
    && hasPermissionForLocation(user, locationId, 'whatsapp')
    && hasPermission(user, 'whatsapp')
}

/**
 * The flags the contact page hands the components whose buttons had no gate.
 *
 * @param {object|null} user
 * @param {object|null} contact  the contacts row (location_id)
 */
export function contactWorkGates(user, contact) {
  const loc = contact?.location_id || null
  return {
    canNote: canAddContactNote(user, loc),
    canTask: isMemberOfContactStudio(user, loc),
    canSequence: canEnrolContactInSequence(user, loc),
    canCancelForm: canSendCancellationForm(user, loc),
    canCold: canSetPipelineStatus(user, loc),
    canLinkAccounts: canLinkContacts(user, loc),
    canStartWhatsApp: canStartWhatsAppThread(user, loc),
    canBook: isMemberOfContactStudio(user, loc),
    canReadConsent: isMemberOfContactStudio(user, loc),
  }
}
