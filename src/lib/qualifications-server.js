// src/lib/qualifications-server.js
//
// QUALS.1 — the data layer behind /api/qualifications/** and
// /api/schedule/template-qualifications, and the ranked picker's facts.
// Service-role client passed in (CLAUDE.md: "Service-role routes get NO
// RLS"). The routes judge what the REQUEST tells them (signed in, a studio
// the caller belongs to, a coarse role); every check that needs a ROW (whose
// record is this, which organisation is this type in, is the person current)
// lives here and answers 404 for anything the caller may not touch, so an id
// is never confirmed.
//
// WHO (plan decisions 2 and 7):
//   records    owner or manager (master bypasses) AT a studio the person
//              belongs to, inside the record's organisation
//   catalogue  owner (master bypasses) at a studio of the organisation
//   template   requirements: MANAGER_ROLES at the template's studio, the
//              template editor's own gate (SCHEDROLES.1)
// A deactivated person or a tombstone is never listed and never written for
// (isRosterableProfile); a tombstone also has no profile_locations (mig 622).
//
// Returns { status, body } for the routes to send as they are. Never throws.

import { hasRoleAtLocation } from './role-at-location'
import { MANAGER_ROLES } from './schemas'
import { isRosterableProfile } from './roster-write'
import { logWarn } from './log'
import { MAX_TEMPLATE_REQUIREMENTS } from './qualifications-schemas'

export const QUAL_MANAGER_ROLES = Object.freeze(['owner', 'manager'])
export const QUAL_CATALOGUE_ROLES = Object.freeze(['owner'])

const PAGE = 1000
const PEOPLE_CHUNK = 100 // × a handful of types per person stays under a page
const TEMPLATE_CHUNK = 200
const TYPE_COLUMNS = 'id, organization_id, name, active, sort_order'
const RECORD_COLUMNS = 'id, organization_id, profile_id, qualification_type_id, issued_on, expires_on, note, updated_at'
const REQUIREMENTS = 'shift_template_qualification_requirements'

const ok = (body, status = 200) => ({ status, body: { success: true, ...body } })
const fail = (status, error) => ({ status, body: { success: false, error } })
const notFound = () => fail(404, 'Not found')
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const cmpText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { sensitivity: 'base' })
const cleanNote = (note) => (typeof note === 'string' && note.trim() ? note.trim() : null)
const chunks = (list, size) => {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function readFailed(what, error) {
  logWarn('qualifications', `${what} read failed`, { err: error?.message })
  return fail(500, `Could not read the ${what}`)
}

function writeFailed(error) {
  if (error?.code === '23505') return fail(409, 'This person already has a record of that qualification. Edit it instead.')
  if (error?.code === '23514') return fail(400, 'Check the dates and the note: the expiry cannot be before the issue date, and a note is at most 300 characters.')
  if (/^qualification_requirement_other_org/.test(String(error?.message || ''))) return fail(400, 'Unknown qualification type')
  logWarn('qualifications', 'write failed', { code: error?.code, err: error?.message })
  return fail(500, 'Could not save the change')
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** The organisation a studio belongs to. */
export async function readLocationOrganization(db, locationId) {
  const { data, error } = await db.from('locations').select('id, organization_id').eq('id', locationId).maybeSingle()
  if (error) return { organizationId: null, error }
  return { organizationId: data?.organization_id ?? null, error: null }
}

/** Current (active, not tombstoned) members of one studio, A–Z. */
export async function readStudioMembers(db, locationId) {
  const members = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('profile_locations')
      .select('profile_id, profiles!inner(id, full_name, active, deleted_at)')
      .eq('location_id', locationId)
      .order('profile_id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { members: null, error }
    for (const l of data || []) {
      if (!l?.profile_id || !isRosterableProfile(l.profiles)) continue
      members.push({ profile_id: l.profile_id, full_name: l.profiles.full_name ?? null })
    }
    if (!data || data.length < PAGE) break
  }
  members.sort((a, b) => cmpText(a.full_name, b.full_name) || a.profile_id.localeCompare(b.profile_id))
  return { members, error: null }
}

/** An organisation's catalogue, archived types included (their records still show). */
export async function readQualificationTypes(db, organizationId) {
  const { data, error } = await db
    .from('staff_qualification_types')
    .select(TYPE_COLUMNS)
    .eq('organization_id', organizationId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) return { types: null, error }
  return { types: data || [], error: null }
}

/** These people's records in one organisation (chunked, each chunk paged). */
export async function readQualificationRecords(db, { organizationId, profileIds }) {
  const records = []
  for (const ids of chunks([...new Set((profileIds || []).filter(Boolean))], PEOPLE_CHUNK)) {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db
        .from('staff_qualifications')
        .select(RECORD_COLUMNS)
        .eq('organization_id', organizationId)
        .in('profile_id', ids)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) return { records: null, error }
      records.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
  }
  return { records, error: null }
}

/**
 * GET /api/qualifications. The route has already checked the caller belongs
 * to `locationId`. A records manager there gets every current member; anyone
 * else gets their own records, read-only.
 */
export async function loadQualificationsPage(db, { user, locationId, today }) {
  const manager = hasRoleAtLocation(user, locationId, QUAL_MANAGER_ROLES)
  const org = await readLocationOrganization(db, locationId)
  if (org.error) return readFailed('studio', org.error)
  if (!org.organizationId) return notFound()

  const { types, error: typeErr } = await readQualificationTypes(db, org.organizationId)
  if (typeErr) return readFailed('qualification types', typeErr)

  let people
  if (manager) {
    const { members, error } = await readStudioMembers(db, locationId)
    if (error) return readFailed('team', error)
    people = members
  } else {
    people = [{ profile_id: user.id, full_name: user.full_name ?? null }]
  }

  const { records, error: recErr } = await readQualificationRecords(db, {
    organizationId: org.organizationId, profileIds: people.map((p) => p.profile_id),
  })
  if (recErr) return readFailed('qualifications', recErr)
  const byPerson = new Map()
  for (const r of records) {
    if (!byPerson.has(r.profile_id)) byPerson.set(r.profile_id, [])
    byPerson.get(r.profile_id).push(r)
  }

  return ok({
    data: {
      audience: manager ? 'manager' : 'self',
      today,
      organization_id: org.organizationId,
      can_edit_types: manager && hasRoleAtLocation(user, locationId, QUAL_CATALOGUE_ROLES),
      types,
      people: people.map((p) => ({ ...p, records: byPerson.get(p.profile_id) || [] })),
    },
  })
}

// ── Authority on a row ─────────────────────────────────────────────────────

/**
 * A studio, in `organizationId`, that the person currently belongs to and
 * where the caller may manage records; null when there is none. A person has
 * a handful of profile_locations rows, so this does not page.
 */
export async function findManagingStudio(db, { user, profileId, organizationId }) {
  const { data, error } = await db
    .from('profile_locations')
    .select('location_id, locations!inner(id, organization_id), profiles!inner(id, active, deleted_at)')
    .eq('profile_id', profileId)
  if (error) return { locationId: null, error }
  const studios = (data || [])
    .filter((l) => l?.locations?.organization_id === organizationId && isRosterableProfile(l.profiles))
    .map((l) => l.location_id)
    .sort()
  return { locationId: studios.find((loc) => hasRoleAtLocation(user, loc, QUAL_MANAGER_ROLES)) ?? null, error: null }
}

/** May this caller edit this organisation's catalogue? Owner at one of its studios, or a master. */
export function canEditCatalogue(user, organizationId) {
  if (!user || !organizationId) return false
  if (user.profileRole === 'master') return true
  return (user.locations || []).some((l) => l?.organization_id === organizationId && hasRoleAtLocation(user, l.id, QUAL_CATALOGUE_ROLES))
}

// ── Records ────────────────────────────────────────────────────────────────

export async function createQualificationRecord(db, { user, input }) {
  const { data: type, error: typeErr } = await db
    .from('staff_qualification_types')
    .select(TYPE_COLUMNS)
    .eq('id', input.qualification_type_id)
    .maybeSingle()
  if (typeErr) return readFailed('qualification type', typeErr)
  if (!type) return notFound()

  const managing = await findManagingStudio(db, { user, profileId: input.profile_id, organizationId: type.organization_id })
  if (managing.error) return readFailed('memberships', managing.error)
  if (!managing.locationId) return notFound()
  if (type.active === false) return fail(400, 'That qualification type is archived. Restore it first.')

  const { data, error } = await db
    .from('staff_qualifications')
    .insert({
      organization_id: type.organization_id,
      profile_id: input.profile_id,
      qualification_type_id: type.id,
      issued_on: input.issued_on ?? null,
      expires_on: input.expires_on ?? null,
      note: cleanNote(input.note),
      recorded_by: user.id,
      updated_by: user.id,
    })
    .select(RECORD_COLUMNS)
    .single()
  if (error) return writeFailed(error)
  return ok({ data }, 201)
}

async function loadManagedRecord(db, { user, id }) {
  const { data: record, error } = await db.from('staff_qualifications').select(RECORD_COLUMNS).eq('id', id).maybeSingle()
  if (error) return { out: readFailed('qualification', error) }
  if (!record) return { out: notFound() }
  const managing = await findManagingStudio(db, { user, profileId: record.profile_id, organizationId: record.organization_id })
  if (managing.error) return { out: readFailed('memberships', managing.error) }
  if (!managing.locationId) return { out: notFound() }
  return { record }
}

export async function updateQualificationRecord(db, { user, id, input }) {
  const { record, out } = await loadManagedRecord(db, { user, id })
  if (out) return out

  // Judge the dates as they WILL be, not only as sent.
  const issued = has(input, 'issued_on') ? input.issued_on : record.issued_on
  const expires = has(input, 'expires_on') ? input.expires_on : record.expires_on
  if (issued && expires && expires < issued) return fail(400, 'The expiry date is before the issue date')

  const patch = { updated_by: user.id, updated_at: new Date().toISOString() }
  if (has(input, 'issued_on')) patch.issued_on = input.issued_on ?? null
  if (has(input, 'expires_on')) patch.expires_on = input.expires_on ?? null
  if (has(input, 'note')) patch.note = cleanNote(input.note)

  const { data, error } = await db
    .from('staff_qualifications')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', record.organization_id)
    .select(RECORD_COLUMNS)
  if (error) return writeFailed(error)
  if (!data?.length) return notFound()
  return ok({ data: data[0] })
}

export async function deleteQualificationRecord(db, { user, id }) {
  const { record, out } = await loadManagedRecord(db, { user, id })
  if (out) return out
  const { data, error } = await db
    .from('staff_qualifications')
    .delete()
    .eq('id', id)
    .eq('organization_id', record.organization_id)
    .select('id')
  if (error) return writeFailed(error)
  if (!data?.length) return notFound()
  return ok({ data: { id, deleted: true } })
}

// ── The catalogue ──────────────────────────────────────────────────────────

/** The route has checked the caller is an owner (or master) at input.location_id. */
export async function createQualificationType(db, { user, input }) {
  const org = await readLocationOrganization(db, input.location_id)
  if (org.error) return readFailed('studio', org.error)
  if (!org.organizationId) return notFound()
  const { data, error } = await db
    .from('staff_qualification_types')
    .insert({ organization_id: org.organizationId, name: input.name, created_by: user.id })
    .select(TYPE_COLUMNS)
    .single()
  if (error?.code === '23505') return fail(409, 'There is already a qualification type with that name.')
  if (error) return writeFailed(error)
  return ok({ data }, 201)
}

export async function updateQualificationType(db, { user, id, input }) {
  const { data: type, error } = await db.from('staff_qualification_types').select(TYPE_COLUMNS).eq('id', id).maybeSingle()
  if (error) return readFailed('qualification type', error)
  if (!type || !canEditCatalogue(user, type.organization_id)) return notFound()
  const patch = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.active !== undefined) patch.active = input.active
  const { data, error: updErr } = await db
    .from('staff_qualification_types')
    .update(patch)
    .eq('id', id)
    .eq('organization_id', type.organization_id)
    .select(TYPE_COLUMNS)
  if (updErr?.code === '23505') return fail(409, 'There is already a qualification type with that name.')
  if (updErr) return writeFailed(updErr)
  if (!data?.length) return notFound()
  return ok({ data: data[0] })
}

// ── Template requirements ──────────────────────────────────────────────────

async function readTemplateIds(db, locationId) {
  const ids = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('shift_templates')
      .select('id')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) return { ids: null, error }
    ids.push(...(data || []).map((t) => t.id))
    if (!data || data.length < PAGE) break
  }
  return { ids, error: null }
}

/**
 * GET /api/schedule/template-qualifications. The route has checked the caller
 * manages templates at `locationId`. { types (the whole catalogue, archived
 * flagged), requirements: { [template_id]: [type_id] } }.
 */
export async function readTemplateRequirements(db, { locationId }) {
  const org = await readLocationOrganization(db, locationId)
  if (org.error) return readFailed('studio', org.error)
  if (!org.organizationId) return notFound()
  const [typeRead, templateRead] = await Promise.all([
    readQualificationTypes(db, org.organizationId),
    readTemplateIds(db, locationId),
  ])
  if (typeRead.error) return readFailed('qualification types', typeRead.error)
  if (templateRead.error) return readFailed('templates', templateRead.error)

  const requirements = {}
  for (const ids of chunks(templateRead.ids, TEMPLATE_CHUNK)) {
    const { data, error } = await db
      .from(REQUIREMENTS)
      .select('template_id, qualification_type_id')
      .in('template_id', ids)
    if (error) return readFailed('template requirements', error)
    for (const r of data || []) (requirements[r.template_id] ||= []).push(r.qualification_type_id)
  }
  return ok({ data: { types: typeRead.types, requirements } })
}

/**
 * PUT /api/schedule/template-qualifications: replace one template's set.
 * Two statements (remove, then add), not one transaction: a failure between
 * them leaves a subset, and repeating the save completes it (both halves are
 * idempotent).
 */
export async function replaceTemplateRequirements(db, { user, input }) {
  const { data: template, error } = await db
    .from('shift_templates')
    .select('id, location_id')
    .eq('id', input.template_id)
    .maybeSingle()
  if (error) return readFailed('template', error)
  if (!template) return notFound()
  const member = user?.profileRole === 'master' || (user?.locations || []).some((l) => l?.id === template.location_id)
  if (!member) return notFound()
  if (!hasRoleAtLocation(user, template.location_id, MANAGER_ROLES)) {
    return fail(403, 'Only a manager at this studio can change what a shift template asks for.')
  }

  const wanted = [...new Set(input.qualification_type_ids || [])]
  if (wanted.length > MAX_TEMPLATE_REQUIREMENTS) return fail(400, 'At most 5 qualifications')

  const org = await readLocationOrganization(db, template.location_id)
  if (org.error) return readFailed('studio', org.error)
  const { data: currentRows, error: curErr } = await db
    .from(REQUIREMENTS)
    .select('qualification_type_id')
    .eq('template_id', template.id)
  if (curErr) return readFailed('template requirements', curErr)
  const current = new Set((currentRows || []).map((r) => r.qualification_type_id))

  if (wanted.length) {
    const { data: types, error: typeErr } = await db.from('staff_qualification_types').select(TYPE_COLUMNS).in('id', wanted)
    if (typeErr) return readFailed('qualification types', typeErr)
    const byId = new Map((types || []).map((t) => [t.id, t]))
    for (const id of wanted) {
      const t = byId.get(id)
      if (!t || t.organization_id !== org.organizationId) return fail(400, 'Unknown qualification type')
      if (t.active === false && !current.has(id)) return fail(400, `${t.name} is archived. Restore it first.`)
    }
  }

  const toRemove = [...current].filter((id) => !wanted.includes(id))
  const toAdd = wanted.filter((id) => !current.has(id))
  if (toRemove.length) {
    const { error: delErr } = await db
      .from(REQUIREMENTS)
      .delete()
      .eq('template_id', template.id)
      .in('qualification_type_id', toRemove)
    if (delErr) return writeFailed(delErr)
  }
  if (toAdd.length) {
    const { error: addErr } = await db
      .from(REQUIREMENTS)
      .upsert(
        toAdd.map((id) => ({ template_id: template.id, qualification_type_id: id, created_by: user.id })),
        { onConflict: 'template_id,qualification_type_id', ignoreDuplicates: true },
      )
    if (addErr) return writeFailed(addErr)
  }
  return ok({ data: { template_id: template.id, qualification_type_ids: wanted, added: toAdd.length, removed: toRemove.length } })
}

// ── The ranked picker's facts (CANDIDATES.1 plug-in) ───────────────────────

/**
 * What one block's template asks for, and these people's records of exactly
 * those types. Archived types are not advised on. Never throws; a failed read
 * is { error } so the picker says "not checked", never "nothing required".
 * @returns {Promise<{ required: Array<{ id, name, organization_id }>|null, records: object[]|null, error }>}
 */
export async function readBlockQualificationFacts(db, { templateId, profileIds = [] } = {}) {
  if (!templateId) return { required: [], records: [], error: null }
  try {
    const { data, error } = await db
      .from(REQUIREMENTS)
      .select('qualification_type_id, staff_qualification_types!inner(id, name, organization_id, active)')
      .eq('template_id', templateId)
    if (error) return { required: null, records: null, error }
    const required = (data || [])
      .map((r) => r?.staff_qualification_types)
      .filter((t) => t?.id && t.active !== false)
      .map((t) => ({ id: t.id, name: t.name, organization_id: t.organization_id }))
      .sort((a, b) => cmpText(a.name, b.name) || a.id.localeCompare(b.id))
    const ids = [...new Set((profileIds || []).filter(Boolean))]
    if (!required.length || !ids.length) return { required, records: [], error: null }

    const organizationId = required[0].organization_id
    const typeIds = required.map((t) => t.id)
    const records = []
    for (const chunk of chunks(ids, PEOPLE_CHUNK)) {
      for (let offset = 0; ; offset += PAGE) {
        const { data: rows, error: recErr } = await db
          .from('staff_qualifications')
          .select('profile_id, qualification_type_id, expires_on')
          .eq('organization_id', organizationId)
          .in('qualification_type_id', typeIds)
          .in('profile_id', chunk)
          .order('id', { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (recErr) return { required: null, records: null, error: recErr }
        records.push(...(rows || []))
        if (!rows || rows.length < PAGE) break
      }
    }
    return { required, records, error: null }
  } catch (e) {
    return { required: null, records: null, error: { message: e?.message || 'qualification facts read threw' } }
  }
}
