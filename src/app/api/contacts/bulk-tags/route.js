// POST /api/contacts/bulk-tags  (CONTACTTAGS.1)
//
// Add or remove ONE manual tag (contacts.tags) on up to 500 contacts at the
// caller's ACTIVE studio, from the contacts list's bulk bar.
//
// Body: { contact_ids: uuid[] (1..500), tag: string, action: 'add' | 'remove' }
//
// Gate: a master, or MANAGER_ROLES at the active studio with Contacts there
// (canBulkTagAt). The role bar is PUT /api/contacts/[id]'s, the single-contact
// writer of the same column; Contacts is what lets the caller read the
// studio's contacts at all.
//
// Scope: only contacts the active studio may act on are touched, through the
// same helper the bulk sequence enrol uses (contactIdsLinkedToStudio: the
// studio's own contacts, plus a same-organisation contact holding a
// contact_studios row there), and each one is then judged by canEditContact,
// PUT's own decision. Anything else (another studio's contact, an id that does
// not exist) is counted in `skipped` and never named, so the answer cannot
// confirm that an id exists elsewhere.
//
// Concurrency: each row is a compare-and-set. The UPDATE carries the tags we
// read as a filter (`tags = <old>`), so an edit that landed in between makes
// it match zero rows; we then re-read that one contact and try again, up to
// MAX_ATTEMPTS. A row that keeps moving, or any write error, is `failed`
// (logged), never reported as updated.
//
// Sequences: PUT /api/contacts/[id] fires tag_added sequence triggers for a
// newly added tag, so a bulk add does too, for exactly the contacts that
// gained it. Pre-checked with ONE read of the studios' active tag_added
// sequences for this tag, so a tag no sequence listens for costs nothing per
// contact. A remove fires nothing (PUT fires nothing for a removal either).
// No timeline row is written: PUT writes none for a tag change.
//
// Answer: { success, data: { requested, updated, unchanged, skipped, failed } }
//   unchanged — readable, and already had (add) / never had (remove) the tag.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { contactIdsLinkedToStudio } from '@/lib/contact-studio-link'
import { canEditContact } from '@/lib/contact-edit-gates'
import { triggerSequencesForTagsAdded } from '@/lib/sequences'
import {
  normaliseManualTag, manualTagProblem, applyManualTagChange, textArrayLiteral,
  TAG_MAX_LENGTH,
} from '@/lib/contact-manual-tags'
import { canBulkTagAt } from '@/lib/contact-bulk-tag-gate'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_ATTEMPTS = 3
const READ_CHUNK = 200

const Body = z.object({
  contact_ids: z.array(uuidLike).min(1).max(500),
  tag: z.string().min(1).max(TAG_MAX_LENGTH * 2),
  action: z.enum(['add', 'remove']),
})

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function readContacts(db, ids) {
  const rows = []
  for (const chunk of chunks(ids, READ_CHUNK)) {
    const { data, error } = await db
      .from('contacts')
      .select('id, location_id, tags')
      .in('id', chunk)
    if (error) return { ok: false, error }
    rows.push(...(data || []))
  }
  return { ok: true, rows }
}

// One compare-and-set write. Returns 'updated' | 'unchanged' | 'conflict' | 'error'.
async function writeOnce(db, row, tag, action) {
  const change = applyManualTagChange(row.tags, tag, action)
  if (change.tooMany) return { outcome: 'error', reason: 'too_many_tags' }
  if (!change.changed) return { outcome: 'unchanged' }
  let q = db.from('contacts').update({ tags: change.next }).eq('id', row.id)
  q = row.tags == null ? q.is('tags', null) : q.filter('tags', 'eq', textArrayLiteral(row.tags))
  const { data, error } = await q.select('id')
  if (error) return { outcome: 'error', reason: error.code || 'write_failed', error }
  if (!Array.isArray(data) || data.length === 0) return { outcome: 'conflict' }
  return { outcome: 'updated' }
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = user.activeLocation?.id || null
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'Pick a studio first' }, { status: 400 })
  }
  const hidden = assertLocationAccessOr404(user, locationId)
  if (hidden) return hidden
  if (!canBulkTagAt(user, locationId)) {
    return NextResponse.json({
      success: false,
      error: 'Head coach, manager, owner or master with Contacts at this studio required',
    }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { contact_ids, action } = validation.data
  const tag = normaliseManualTag(validation.data.tag)
  const problem = manualTagProblem(tag)
  if (problem) return NextResponse.json({ success: false, error: problem }, { status: 400 })

  const uniqueIds = [...new Set(contact_ids)]
  const result = { requested: uniqueIds.length, updated: 0, unchanged: 0, skipped: 0, failed: 0 }
  const db = createServerClient()

  const linked = await contactIdsLinkedToStudio(db, { locationId, contactIds: uniqueIds })
  if (!linked.ok) {
    logError('contacts.bulk-tags', 'studio link check failed; nothing written', { locationId, reason: linked.reason, err: linked.err || null })
    return NextResponse.json({ success: false, error: 'Could not check those contacts. Nothing was changed. Try again in a moment.' }, { status: 503 })
  }
  const linkedIds = new Set(linked.ids)

  const read = await readContacts(db, linked.ids)
  if (!read.ok) {
    logError('contacts.bulk-tags', 'contacts read failed; nothing written', { locationId, code: read.error?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not read those contacts. Nothing was changed. Try again in a moment.' }, { status: 503 })
  }
  const byId = new Map(read.rows.map((r) => [r.id, r]))

  const gained = [] // { id, location_id } of contacts that newly carry the tag
  for (const id of uniqueIds) {
    let row = linkedIds.has(id) ? byId.get(id) : null
    // Linked to this studio, so canEditContact is PUT's decision with this
    // studio as the relationship (it also refuses a contact with no primary).
    if (!row || !canEditContact({ user, contact: row, relationshipStudioIds: [locationId] })) {
      result.skipped += 1
      continue
    }
    let done = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
      const w = await writeOnce(db, row, tag, action)
      if (w.outcome === 'updated') {
        result.updated += 1
        if (action === 'add') gained.push({ id, location_id: row.location_id })
        done = true
      } else if (w.outcome === 'unchanged') {
        result.unchanged += 1
        done = true
      } else if (w.outcome === 'error') {
        result.failed += 1
        logError('contacts.bulk-tags', 'tag write failed', { contactId: id, reason: w.reason, code: w.error?.code ?? null })
        done = true
      } else if (attempt < MAX_ATTEMPTS) {
        // Someone else changed this contact's tags since we read them.
        const { data: fresh, error: freshErr } = await db
          .from('contacts')
          .select('id, location_id, tags')
          .eq('id', id)
          .maybeSingle()
        if (freshErr || !fresh) {
          result.failed += 1
          logError('contacts.bulk-tags', 'conflict re-read failed', { contactId: id, code: freshErr?.code ?? null, missing: !fresh })
          done = true
        } else {
          row = fresh
        }
      }
    }
    if (!done) {
      result.failed += 1
      logWarn('contacts.bulk-tags', 'tags kept changing underneath; gave up', { contactId: id, attempts: MAX_ATTEMPTS })
    }
  }

  if (gained.length > 0) await fireTagAddedSequences(db, gained, tag)

  return NextResponse.json({ success: true, data: result })
}

// Best-effort, like PUT's: a sequence problem never changes the answer.
async function fireTagAddedSequences(db, gained, tag) {
  try {
    const homes = [...new Set(gained.map((g) => g.location_id).filter(Boolean))]
    if (homes.length === 0) return
    const { data: sequences, error } = await db
      .from('email_sequences')
      .select('id, location_id, trigger_config')
      .in('location_id', homes)
      .eq('trigger_type', 'tag_added')
      .eq('status', 'active')
    if (error) {
      logWarn('contacts.bulk-tags', 'tag_added sequence lookup failed; no enrolments', { code: error.code ?? null })
      return
    }
    const listening = new Set((sequences || []).filter((s) => s?.trigger_config?.tag === tag).map((s) => s.location_id))
    for (const g of gained) {
      if (!listening.has(g.location_id)) continue
      try {
        await triggerSequencesForTagsAdded(g.id, [tag])
      } catch (e) {
        logWarn('contacts.bulk-tags', `tag_added trigger error for ${g.id}`, { err: e })
      }
    }
  } catch (e) {
    logWarn('contacts.bulk-tags', 'tag_added sequences failed', { err: e })
  }
}
