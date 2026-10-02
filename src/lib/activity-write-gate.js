// C146 TASKSNEEDCONTACTS.1 — may the browser offer a task / activity write?
//
// Mig 700 (C144, Richard 2 Oct) made reading `activities` need Contacts at the
// row's studio: activities_select = (phone Tasks OR phone Pipeline) AND
// private.auth_contact_read_location_ids(). The browser writes `activities`
// directly (TasksPage, ContactActions, PersonActionBar), and at a studio where
// the person cannot read Contacts those writes go wrong in three ways: an
// insert that reads its row back (TasksPage.addTask) is refused; an update by
// id (TasksPage.updateStatus) finds no row and changes nothing, without an
// error; a plain insert (the contact and pipeline Task items) lands a row the
// person can then never see. Richard's call: do not offer them there.
//
// auth_contact_read_location_ids() is Contacts on the WEB or the PHONE at the
// studio, through resolvePermission's tiers (studio switch + bundle, master,
// per-user override, employment-type template, 'all' template, role default),
// which is what hasPermissionForLocation / hasMobilePermissionForLocation
// resolve. UI only: RLS is the enforcement.

import { hasPermissionForLocation, hasMobilePermissionForLocation } from './permissions'

/**
 * Contacts (web OR phone) at `locationId`, the studio the write lands at.
 *
 * @param {object|null} user        getCurrentUser() result
 * @param {string|null} locationId  the row's studio
 * @returns {boolean}
 */
export function canWriteActivitiesAt(user, locationId) {
  if (!user || !locationId) return false
  return hasPermissionForLocation(user, locationId, 'contacts')
    || hasMobilePermissionForLocation(user, locationId, 'contacts')
}

/**
 * The per-person kebab (PersonActionBar) items for a board: `task` is a
 * browser `activities` insert, so it goes where canWriteActivitiesAt says no.
 *
 * @param {string[]} actions
 * @param {{ canTask?: boolean }} [gates]
 * @returns {string[]}
 */
export function personActionsFor(actions, { canTask = true } = {}) {
  return (actions || []).filter((a) => canTask || a !== 'task')
}

/**
 * Judge `update(…).eq('id', x).select('id')`. A zero-row UPDATE is not an
 * error in PostgREST, so "no row came back" has to be read as the failure it
 * is (the row is gone, or RLS hides it from this session).
 *
 * @param {{ data: Array|null, error: { message?: string }|null }} res
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function taskStatusUpdateOutcome({ data, error } = {}) {
  if (error) return { ok: false, message: error.message || 'The task could not be updated.' }
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, message: 'Not saved: this task could not be updated from your login here.' }
  }
  return { ok: true }
}
