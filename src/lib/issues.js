// REPORT-ISSUE.1 — pure helpers + storage path generation for the
// staff-submitted issues feature. The API routes wrap these; the
// pure functions get straight unit tests.
//
// Storage path scheme (issue-photos bucket):
//   {location_id}/{issue_id}/{attachment_id}-{slug}
//
// - location_id prefix keeps the bucket browsable by location for
//   support pulls without RLS games.
// - issue_id groups all photos for a single submission together so
//   a cascade delete on the issues row can list+delete the prefix
//   in one storage call.
// - attachment_id prefix guarantees uniqueness even if two photos
//   share a filename (very common with iOS Camera which auto-names
//   files IMG_0001.jpeg).
// - slug is the original filename lowercased + sanitised so support
//   pulls are human-readable.

import { logWarn } from '@/lib/log'

export const ISSUE_STATUS = Object.freeze({
  OPEN:        'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED:    'resolved',
  CLOSED:      'closed',
})

export const ISSUE_ACTIVE_STATUSES = Object.freeze(['open', 'in_progress'])

// Photo limits. Mirror the FTE-EXPENSES.3 receipt limits — phone
// cameras default to 3-6 MB JPEGs so we cap at 10 MB to be safe
// without making the operator think about it. PNG / HEIC also
// accepted; PDFs deferred to PR 2 if anyone asks (rare for a
// "broken thing in the gym" report).
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
export const MAX_PHOTOS_PER_ISSUE = 3
export const ALLOWED_PHOTO_MIME = Object.freeze([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
])

// Description bounds. The DB CHECK caps at 4000; we surface a
// friendlier limit to the UI. 1500 is comfortable for a paragraph
// + steps-to-reproduce without the form feeling like an essay.
export const DESCRIPTION_MIN = 1
export const DESCRIPTION_MAX = 4000

/**
 * Lowercase + sanitise a filename into a URL-safe slug. Preserves
 * the file extension if there is one so support pulls open in the
 * right app on the operator's machine.
 *
 * "IMG_0001 (1).JPEG" → "img_0001-1.jpeg"
 * "Bröken kit!.png"   → "broken-kit.png"
 * "screenshot"        → "screenshot"
 */
export function slugifyFilename(name) {
  if (!name || typeof name !== 'string') return 'photo'
  // Split off the extension if present.
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext  = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const slug = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .toLowerCase()
    // Underscores are URL-safe and worth preserving — iOS Camera
    // names files IMG_0001.jpeg and operators read those filenames
    // when triaging support pulls. Hyphens replace everything else.
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'photo'
  return ext ? `${slug}.${ext.replace(/[^a-z0-9]/g, '')}` : slug
}

/**
 * Compose the storage path for an attachment. Pure — used by both
 * the upload code and the tests so we can assert the layout
 * without standing up a Supabase client.
 */
export function buildAttachmentPath({ locationId, issueId, attachmentId, filename }) {
  if (!locationId || !issueId || !attachmentId) {
    throw new Error('buildAttachmentPath: locationId, issueId, attachmentId required')
  }
  return `${locationId}/${issueId}/${attachmentId}-${slugifyFilename(filename)}`
}

/**
 * Validate a submission body. Returns { ok: true } or
 * { ok: false, error, code }. Pure — no DB, no storage.
 *
 * Photos here are { filename, size, type } shape; the actual bytes
 * are validated when we read them off the multipart form.
 */
export function validateSubmission({ description, photos = [] } = {}) {
  const desc = typeof description === 'string' ? description.trim() : ''
  if (desc.length < DESCRIPTION_MIN) {
    return { ok: false, code: 'description_required', error: 'A description is required.' }
  }
  if (desc.length > DESCRIPTION_MAX) {
    return { ok: false, code: 'description_too_long', error: `Description must be ${DESCRIPTION_MAX} characters or fewer.` }
  }
  if (!Array.isArray(photos)) {
    return { ok: false, code: 'photos_bad_shape', error: 'Photos must be a list.' }
  }
  if (photos.length > MAX_PHOTOS_PER_ISSUE) {
    return {
      ok: false,
      code: 'too_many_photos',
      error: `Attach at most ${MAX_PHOTOS_PER_ISSUE} photos per issue.`,
    }
  }
  for (const p of photos) {
    if (!p || typeof p !== 'object') {
      return { ok: false, code: 'photo_bad_shape', error: 'Each photo must include a file.' }
    }
    if (typeof p.size !== 'number' || p.size <= 0) {
      return { ok: false, code: 'photo_empty', error: 'A photo is empty or unreadable.' }
    }
    if (p.size > MAX_PHOTO_BYTES) {
      return {
        ok: false,
        code: 'photo_too_large',
        error: `Photos must be under ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB each.`,
      }
    }
    if (typeof p.type !== 'string' || !ALLOWED_PHOTO_MIME.includes(p.type.toLowerCase())) {
      return {
        ok: false,
        code: 'photo_bad_type',
        error: 'Photos must be JPEG, PNG, WebP, or HEIC.',
      }
    }
  }
  return { ok: true, normalised: { description: desc, photos } }
}

/**
 * Insert an issue + its attachments in a single logical operation.
 * The caller has already uploaded each photo's bytes to storage and
 * passes the {path, bucket, size, type, filename} for each. Returns
 * the inserted issue row on success.
 *
 * We don't wrap in a transaction because Supabase JS doesn't expose
 * one cleanly; instead we insert the parent, then attachments, and
 * on attachment failure we delete the parent to avoid orphans. The
 * storage objects are best-effort cleaned by the caller on failure
 * (the route handles that).
 */
export async function insertIssueWithAttachments(db, {
  locationId, submitterId, description, attachments = [],
}) {
  const { data: issue, error: issueErr } = await db
    .from('issues')
    .insert({
      location_id: locationId,
      submitter_id: submitterId,
      description,
      status: ISSUE_STATUS.OPEN,
    })
    .select('id, location_id, submitter_id, description, status, created_at')
    .single()

  if (issueErr) {
    logWarn('issues', 'insert issue failed', { locationId, error: issueErr.message })
    return { ok: false, status: 500, error: issueErr.message, code: 'issue_insert_failed' }
  }

  if (attachments.length === 0) {
    return { ok: true, issue, attachments: [] }
  }

  const attachmentRows = attachments.map((a, idx) => ({
    issue_id:     issue.id,
    storage_path: a.storage_path,
    bucket:       a.bucket || 'issue-photos',
    size_bytes:   a.size_bytes,
    mime_type:    a.mime_type,
    position:     idx,
    uploaded_by:  submitterId,
  }))

  const { data: attRows, error: attErr } = await db
    .from('issue_attachments')
    .insert(attachmentRows)
    .select('id, storage_path, bucket, size_bytes, mime_type, position, created_at')

  if (attErr) {
    // Roll back the parent so we don't leave an issue with no
    // photos referencing storage objects nobody can find.
    await db.from('issues').delete().eq('id', issue.id)
    logWarn('issues', 'insert attachments failed', { issueId: issue.id, error: attErr.message })
    return { ok: false, status: 500, error: attErr.message, code: 'attachment_insert_failed' }
  }

  return { ok: true, issue, attachments: attRows }
}

/**
 * List the caller's own submitted issues. The inbox flow (PR 2)
 * uses a different list helper — this is purely "what have I
 * reported".
 */
export async function listMyIssues(db, submitterId, { limit = 50 } = {}) {
  if (!submitterId) return []
  const { data, error } = await db
    .from('issues')
    .select(`
      id, location_id, description, status,
      created_at, claimed_at, resolved_at, closed_at,
      resolution_notes,
      locations:location_id ( id, name ),
      issue_attachments ( id, storage_path, bucket, mime_type, position )
    `)
    .eq('submitter_id', submitterId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    logWarn('issues', 'listMyIssues failed', { submitterId, error: error.message })
    return []
  }
  return data || []
}

/**
 * Fetch a single issue by id, only if the caller is the submitter.
 * The handler inbox uses a separate read path that checks role.
 */
export async function getMyIssue(db, { issueId, profileId }) {
  if (!issueId || !profileId) return null
  const { data } = await db
    .from('issues')
    .select(`
      id, location_id, submitter_id, description, status,
      created_at, claimed_at, resolved_at, closed_at,
      resolution_notes,
      locations:location_id ( id, name ),
      issue_attachments ( id, storage_path, bucket, mime_type, position )
    `)
    .eq('id', issueId)
    .eq('submitter_id', profileId)
    .maybeSingle()
  return data || null
}

// ────────────────────────────────────────────────────────────────
// REPORT-ISSUE.2 — handler side (owner + master inbox)
// ────────────────────────────────────────────────────────────────

// Statuses that count as "open work" for the inbox + sidebar badge.
export const ISSUE_INBOX_OPEN_STATUSES = Object.freeze([
  ISSUE_STATUS.OPEN, ISSUE_STATUS.IN_PROGRESS,
])

const HANDLER_SELECT_COLUMNS = `
  id, location_id, submitter_id, description, status,
  created_at, claimed_at, resolved_at, closed_at,
  claimed_by, resolved_by, resolution_notes,
  locations:location_id ( id, name ),
  submitter:submitter_id ( id, full_name ),
  claimant:claimed_by ( id, full_name ),
  resolver:resolved_by ( id, full_name ),
  issue_attachments ( id, storage_path, bucket, mime_type, position )
`

/**
 * List issues at a location for the handler inbox. Status filter
 * defaults to the "open work" set so the inbox shows what needs
 * attention; callers pass an explicit array for "resolved" /
 * "closed" tabs.
 */
export async function listInboxIssues(db, locationId, {
  statuses = ISSUE_INBOX_OPEN_STATUSES,
  limit = 100,
} = {}) {
  if (!locationId) return []
  const { data, error } = await db
    .from('issues')
    .select(HANDLER_SELECT_COLUMNS)
    .eq('location_id', locationId)
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    logWarn('issues', 'listInboxIssues failed', { locationId, error: error.message })
    return []
  }
  return data || []
}

/**
 * Count-only variant for the sidebar badge. Counts open +
 * in_progress at the location.
 */
export async function countInboxIssues(db, locationId) {
  if (!locationId) return 0
  const { count, error } = await db
    .from('issues')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .in('status', ISSUE_INBOX_OPEN_STATUSES)
  if (error) {
    logWarn('issues', 'countInboxIssues failed', { locationId, error: error.message })
    return 0
  }
  return count || 0
}

/**
 * Fetch a single issue for the handler. Unlike getMyIssue this
 * doesn't gate on submitter_id — the route layer checks the
 * caller's role at the issue's location instead.
 */
export async function getInboxIssue(db, issueId) {
  if (!issueId) return null
  const { data } = await db
    .from('issues')
    .select(HANDLER_SELECT_COLUMNS)
    .eq('id', issueId)
    .maybeSingle()
  return data || null
}

/**
 * Claim an open issue. Sets claimed_by + claimed_at and transitions
 * status open → in_progress. Concurrency-safe via the status='open'
 * predicate — if two handlers race, the second one's UPDATE returns
 * no row and the caller is told to refresh.
 *
 * Returns { ok, data } or { ok:false, status, code, error }.
 */
export async function claimIssue(db, { issueId, profileId }) {
  if (!issueId || !profileId) {
    return { ok: false, status: 400, code: 'bad_args', error: 'issueId + profileId required.' }
  }
  const { data, error } = await db
    .from('issues')
    .update({
      claimed_by: profileId,
      claimed_at: new Date().toISOString(),
      status:     ISSUE_STATUS.IN_PROGRESS,
    })
    .eq('id', issueId)
    .eq('status', ISSUE_STATUS.OPEN)
    .select('id, status, claimed_by, claimed_at')
    .single()
  if (error) {
    // PGRST116 = "0 rows" from .single() — means the row wasn't in
    // 'open' state when we tried to claim it.
    if (error.code === 'PGRST116') {
      return {
        ok: false, status: 409, code: 'not_open',
        error: 'This issue is no longer open. Refresh to see the latest state.',
      }
    }
    logWarn('issues', 'claim failed', { issueId, error: error.message })
    return { ok: false, status: 500, code: 'claim_failed', error: error.message }
  }
  return { ok: true, data }
}

/**
 * Mark an issue resolved. Notes are required so the submitter
 * notification has something useful in it. Transitions any
 * non-terminal status → resolved (so a handler can resolve
 * directly from 'open' without claiming first).
 */
export async function resolveIssue(db, { issueId, profileId, notes }) {
  if (!issueId || !profileId) {
    return { ok: false, status: 400, code: 'bad_args', error: 'issueId + profileId required.' }
  }
  const cleaned = typeof notes === 'string' ? notes.trim() : ''
  if (cleaned.length === 0) {
    return { ok: false, status: 400, code: 'notes_required', error: 'A resolution note is required.' }
  }
  if (cleaned.length > 2000) {
    return { ok: false, status: 400, code: 'notes_too_long', error: 'Resolution notes must be 2000 characters or fewer.' }
  }
  const { data, error } = await db
    .from('issues')
    .update({
      resolved_by:      profileId,
      resolved_at:      new Date().toISOString(),
      resolution_notes: cleaned,
      status:           ISSUE_STATUS.RESOLVED,
    })
    .eq('id', issueId)
    // Allow resolution from any non-terminal state (defensive
    // double-check; the route should already prevent re-resolving
    // a closed issue).
    .in('status', [ISSUE_STATUS.OPEN, ISSUE_STATUS.IN_PROGRESS])
    .select(HANDLER_SELECT_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') {
      return {
        ok: false, status: 409, code: 'already_terminal',
        error: 'This issue has already been resolved or closed.',
      }
    }
    logWarn('issues', 'resolve failed', { issueId, error: error.message })
    return { ok: false, status: 500, code: 'resolve_failed', error: error.message }
  }
  return { ok: true, data }
}

/**
 * Close an issue. Owner / master can close a 'resolved' issue,
 * making it terminal. The submitter-side ack flow may also call
 * this in a future PR.
 */
export async function closeIssue(db, { issueId }) {
  if (!issueId) {
    return { ok: false, status: 400, code: 'bad_args', error: 'issueId required.' }
  }
  const { data, error } = await db
    .from('issues')
    .update({
      closed_at: new Date().toISOString(),
      status:    ISSUE_STATUS.CLOSED,
    })
    .eq('id', issueId)
    .eq('status', ISSUE_STATUS.RESOLVED)
    .select(HANDLER_SELECT_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') {
      return {
        ok: false, status: 409, code: 'not_resolved',
        error: 'Only a resolved issue can be closed.',
      }
    }
    logWarn('issues', 'close failed', { issueId, error: error.message })
    return { ok: false, status: 500, code: 'close_failed', error: error.message }
  }
  return { ok: true, data }
}
