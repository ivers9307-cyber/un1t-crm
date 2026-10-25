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
// resolve.
//
// C148 ACTWRITEGATEWEB.1 (Richard 2 Oct: "judge web task saves on the WEB
// permission"). The browser writes were judged by RLS, whose write policies
// (mig 691) ask the PHONE Tasks or Pipeline key, so someone with the web Tasks
// key (`activities`, what /activities opens on) but neither phone key was
// refused. The web writes are service-role routes now
// (POST /api/activities/tasks, POST /api/activities/tasks/[id]/status, gate in
// src/lib/activity-web-writes.js), and this function is their rule AND the
// UI's: the web `activities` key at the row's studio, AND Contacts there
// (web or phone; kept so a write never lands a row its author cannot read).
// Client-safe: imports ./permissions only.

import { hasPermissionForLocation, hasMobilePermissionForLocation } from './permissions'

/**
 * Web Tasks (`activities`) AND Contacts (web OR phone) at `locationId`, the
 * studio the write lands at.
 *
 * @param {object|null} user        getCurrentUser() result
 * @param {string|null} locationId  the row's studio
 * @returns {boolean}
 */
export function canWriteActivitiesAt(user, locationId) {
  if (!user || !locationId) return false
  if (!hasPermissionForLocation(user, locationId, 'activities')) return false
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

const NOT_SAVED = 'Not saved: the task could not be saved. Try again.'

/**
 * Read a task route's answer (the fetch's `ok` and its parsed JSON body).
 * Only `ok` AND `success: true` is a success; anything else carries the
 * route's own message when it sent one.
 *
 * @param {{ ok?: boolean, body?: { success?: boolean, data?: any, error?: string }|null }} res
 * @returns {{ ok: true, data: any } | { ok: false, message: string }}
 */
export function taskWriteOutcome({ ok, body } = {}) {
  if (ok && body?.success === true) return { ok: true, data: body.data ?? null }
  return { ok: false, message: (body && typeof body.error === 'string' && body.error) || NOT_SAVED }
}

/**
 * POST a JSON payload to a task route and judge the answer. A network error
 * or a non-JSON page (a proxy error, a login redirect) is a failure, never a
 * silent success.
 *
 * @param {string} url
 * @param {object} payload
 * @param {typeof fetch} [fetchImpl]
 */
export async function postActivityWrite(url, payload, fetchImpl = globalThis.fetch) {
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, message: NOT_SAVED }
  }
  let body = null
  try { body = await res.json() } catch { /* non-JSON: judged as a failure below */ }
  return taskWriteOutcome({ ok: res.ok, body })
}
