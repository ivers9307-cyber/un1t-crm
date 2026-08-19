// ZOOMSYNC.1 — the /phone/external_contacts surface.
//
// Two Zoom API facts shape this file:
//   * There is no search. You cannot look up by phone or by your own id, so
//     listOwnedContacts() pages everything, every run.
//   * Updates and deletes need Zoom's generated external_contact_id, not our
//     id. Paging the full list is what supplies it, which is also why this
//     feature needs no local mapping table.

import { zoomFetch } from './client'

export const OWNED_PREFIX = 'crm-'
const PAGE_SIZE = 100
const MAX_PAGES = 500 // 50k contacts; a runaway-token backstop, not a real cap

/**
 * Ownership marker. Dash-only and plus-less so the same string is safe as a
 * Zoom id, inside a QStash dedup id, and in a log line.
 */
export function markerFor(e164) {
  return `${OWNED_PREFIX}${e164.replace(/\D/g, '')}`
}

// Named descriptionFor, not describe(contactId) — this module has no test
// colocated in it, but every caller reading it also reads *.test.js files
// where `describe` is vitest's global. Same name, different meaning, one
// keystroke apart from an accidental shadow; not worth the confusion.
function descriptionFor(contactId) {
  return `UN1T CRM sync - ${contactId}`
}

/**
 * @returns {Promise<{ok: true, contacts: Map<string, {zoomId: string, name: string}>, scanned: number}
 *                 | {ok: false, error: string}>}
 * Keyed by E.164. ONLY entries whose id starts with `crm-` are included —
 * anything a human added by hand is invisible to the reconcile, which is what
 * stops the delete pass touching it.
 */
export async function listOwnedContacts() {
  const contacts = new Map()
  let token = ''
  let scanned = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ page_size: String(PAGE_SIZE) })
    if (token) q.set('next_page_token', token)

    const res = await zoomFetch(`/phone/external_contacts?${q}`)
    if (!res.ok) return { ok: false, error: `list page ${page}: ${res.error}` }

    const rows = res.body?.external_contacts ?? []
    scanned += rows.length
    for (const row of rows) {
      if (typeof row?.id !== 'string' || !row.id.startsWith(OWNED_PREFIX)) continue
      const number = row.phone_numbers?.[0]
      if (!number) continue
      contacts.set(number, { zoomId: row.external_contact_id, name: row.name ?? '' })
    }

    token = res.body?.next_page_token || ''
    if (!token) break
  }

  return { ok: true, contacts, scanned }
}

export async function createContact({ e164, name, contactId }) {
  const res = await zoomFetch('/phone/external_contacts', {
    method: 'POST',
    body: {
      id: markerFor(e164),
      name,
      phone_numbers: [e164],
      description: descriptionFor(contactId),
    },
  })
  // An overlapping run can re-enqueue a create that already landed. Zoom
  // rejects the duplicate id/number with a 409; that is the desired end state,
  // so it counts as success and the pipeline stays idempotent.
  if (!res.ok && res.status === 409) return { ok: true, duplicate: true }
  // ZOOMSYNC.4 — `status` rides along on every failure so the worker can tell a
  // permanent verdict on the payload (4xx) from a transient one (5xx, network,
  // rate limit). Without it the only signal was a string, and every failure was
  // retried forever.
  if (!res.ok) return { ok: false, status: res.status, error: `create ${e164}: ${res.error}` }
  return { ok: true }
}

export async function updateContact({ zoomId, name, contactId }) {
  const res = await zoomFetch(`/phone/external_contacts/${zoomId}`, {
    method: 'PATCH',
    body: { name, description: descriptionFor(contactId) },
  })
  if (!res.ok) return { ok: false, status: res.status, error: `update ${zoomId}: ${res.error}` }
  return { ok: true }
}

export async function deleteContact({ zoomId }) {
  const res = await zoomFetch(`/phone/external_contacts/${zoomId}`, { method: 'DELETE' })
  // Already gone is the desired end state.
  if (!res.ok && res.status === 404) return { ok: true, alreadyGone: true }
  if (!res.ok) return { ok: false, status: res.status, error: `delete ${zoomId}: ${res.error}` }
  return { ok: true }
}
