// C148 ACTWRITEGATEWEB.1 — the gate shared by the web task writes
// (POST /api/activities/tasks, POST /api/activities/tasks/[id]/status).
//
// The web Tasks page, the contact page's Activity form and the Task item of
// the contact / pipeline kebab used to write `activities` through the BROWSER
// client, so RLS judged the write, and the activities write policies (mig 691)
// judge the PHONE Tasks or Pipeline key. Someone with the web Tasks key
// (`activities`) but neither phone key was refused. Richard, 2 Oct: judge web
// task saves on the WEB permission. The writes are service-role routes now,
// and the app decides with canWriteActivitiesAt (src/lib/activity-write-gate.js,
// the same function the pages' controls read): the web `activities` key AND
// Contacts (web or phone) at the row's studio. A linked contact must be AT
// that studio (a task at one studio must not carry another studio's contact
// to readers there); an assignee must work there. Server-only (auth.js).
import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from './auth'
import { hasPermissionAtAnyLocation } from './permissions'
import { canWriteActivitiesAt } from './activity-write-gate'

const forbidden = () => NextResponse.json(
  { success: false, error: 'No Tasks permission at this location' }, { status: 403 })
const notFound = (error = 'Not found') => NextResponse.json({ success: false, error }, { status: 404 })
const failed = (error) => NextResponse.json({ success: false, error }, { status: 500 })

/** The coarse pre-check, before any read: the web Tasks key at SOME studio. */
export function activitiesWriteForbiddenAnywhere(user) {
  return hasPermissionAtAnyLocation(user, 'activities') ? null : forbidden()
}

/**
 * The rule at `locationId` (the request body's studio), after the route's own
 * membership check (assertLocationAccess, the body-location 403). Returns a
 * response to send, or null.
 */
export function taskWriteRefusalAt(user, locationId) {
  return canWriteActivitiesAt(user, locationId) ? null : forbidden()
}

/**
 * The links a new task carries: a contact AT the task's studio, and an
 * assignee who works there (the page's picker lists that studio's staff).
 * Returns a response to send, or null.
 *
 * @param {object} db  createServerClient()
 * @param {{ locationId: string, contactId?: string|null, assigneeId?: string|null }} links
 */
export async function taskLinksRefusal(db, { locationId, contactId, assigneeId }) {
  if (contactId) {
    const { data: contact, error } = await db.from('contacts')
      .select('id, location_id')
      .eq('id', contactId)
      .maybeSingle()
    if (error) return failed('Could not read the contact')
    // Missing, or at another studio: one answer, so ids are not enumerable.
    if (!contact || contact.location_id !== locationId) {
      return notFound('Contact not found, or not at this studio: add the task from the contact\'s own studio.')
    }
  }
  if (assigneeId) {
    const { data: member, error } = await db.from('profile_locations')
      .select('profile_id')
      .eq('profile_id', assigneeId)
      .eq('location_id', locationId)
      .maybeSingle()
    if (error) return failed('Could not check the assignee')
    if (!member) {
      return NextResponse.json({ success: false, error: 'The assignee does not work at this studio' }, { status: 400 })
    }
  }
  return null
}

/**
 * Read a task and decide. Returns { response } to send as-is, or { task }.
 * Only `kind = 'task'` rows (an auto-logged event is not edited here); a row
 * with no studio is refused like a missing one (fail closed). Membership is
 * a 404 (detail route), the rule a 403.
 *
 * @param {object} db    createServerClient()
 * @param {object} user  getCurrentUser() result
 * @param {string} id    the task id from the path
 */
export async function loadTaskForWebWrite(db, user, id) {
  const { data: task, error } = await db.from('activities')
    .select('id, kind, status, location_id')
    .eq('id', id)
    .maybeSingle()
  if (error) return { response: failed('Could not read the task') }
  if (!task || task.kind !== 'task' || !task.location_id) return { response: notFound() }
  const guard = assertLocationAccessOr404(user, task.location_id)
  if (guard) return { response: guard }
  if (!canWriteActivitiesAt(user, task.location_id)) return { response: forbidden() }
  return { task }
}
