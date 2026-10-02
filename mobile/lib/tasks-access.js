// C146 TASKSNEEDCONTACTS.1 — where the phone offers task / activity writes.
//
// Mig 700 (C144, Richard 2 Oct) made reading `activities` need Contacts at
// the studio: activities_select = (phone Tasks OR phone Pipeline) AND
// private.auth_contact_read_location_ids(). Every phone write to that table
// reads its row back — tasks-api createTask / setTaskStatus and
// pipeline-api logActivity all end in .select() — and a write that returns
// its row needs the SELECT policy too, so at a studio where the person
// cannot read Contacts the database refuses those writes whole. Richard's
// call: the phone does not offer them there.
//
// The database's Contacts rule is Contacts on the WEB **or** the PHONE at the
// studio, through the same tiers resolvePermission walks (studio switch +
// bundle, master, per-user override, employment-type template, 'all'
// template, role default). canMobile resolves the phone key, canDashboard the
// top-level (web) key, so OR-ing them is that rule exactly. Asking only the
// phone key would hide Tasks from someone whose writes the database accepts.
//
// UI only, like everything in permissions.js: RLS is the enforcement. Every
// caller passes the ACTIVE studio from useAuth() and evaluates in render, so
// switching studio re-evaluates on the next render.

import { canMobile, canDashboard } from './permissions'

/**
 * May this person read Contacts at this studio (web OR phone key)?
 *
 * @param {object|null|undefined} profile         from /api/mobile/me
 * @param {object|null|undefined} activeLocation  from /api/mobile/me
 * @returns {boolean}
 */
export function canReadContactsHere(profile, activeLocation) {
  if (!profile || !activeLocation) return false
  return canMobile(profile, 'contacts', activeLocation)
    || canDashboard(profile, 'contacts', activeLocation)
}

/**
 * The Tasks surface (More tile, list, new task, task detail): the phone
 * Tasks key AND Contacts at the studio.
 */
export function canUseTasksHere(profile, activeLocation) {
  return canMobile(profile, 'tasks', activeLocation)
    && canReadContactsHere(profile, activeLocation)
}

/**
 * The deal screen's Call / Email / Meeting log (a direct `activities`
 * insert that reads its row back). The deal screen itself is Pipeline-gated,
 * which is the write policy's other key, so Contacts is what is left to ask.
 * Notes post to /api/contacts/[id]/notes (the `notes` table) and are not
 * affected.
 */
export function canLogActivityHere(profile, activeLocation) {
  return canReadContactsHere(profile, activeLocation)
}
