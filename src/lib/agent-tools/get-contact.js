// MCP.1 — `get_contact`: one contact's card. Readable when the contact is
// homed at, or has a relationship row at, a studio of the resolved studio's
// organisation (MCP switched on) where the person holds the AI Assistant and
// Contacts permissions (_contact-scope.js); anything else, a random id
// included, answers the same not_found. Once readable, the contact's deals, notes,
// activities and class bookings are read by contact_id, as the contact page
// reads them. The timeline never carries a message body: an activity keeps
// its type and subject only (a WhatsApp activity's `note` holds the message
// text and is not even selected), a note's content is cut to 200 characters.

import { z } from 'zod'
import { defineTool, ToolRefusal } from './registry.js'
import { contactReadableAt, readableContactStudios } from './_contact-scope.js'
import { studiosOfContact } from '@/lib/contact-studios'
import { membershipRowsFromStudioRows } from '@/lib/membership/membership-facts'
import { mergeTimeline } from '@/lib/contact-view'

const TIMELINE_ROWS = 20
const NOTE_CHARS = 200
const MAX_DEALS = 20
const MAX_BOOKINGS = 50
const BOOKING_WINDOW_MS = 30 * 86_400_000

const failed = (what, error) => new Error(`Failed to load the contact's ${what}: ${error.message || error}`)

async function readContact(db, contactId) {
  const { data, error } = await db.from('contacts')
    .select('id, name, email, phone, lead_source, pipeline_stage_slug, created_at')
    .in('id', [contactId])
    .maybeSingle()
  if (error) throw failed('details', error)
  return data
}

/** The relationship rows at studios the person can read, with the membership facts. */
async function readStudios(db, user, contactId, ctx) {
  const res = await studiosOfContact(db, contactId)
  if (!res.ok) throw failed('studios', res.error)
  const readable = new Set(readableContactStudios(user, ctx))
  return res.rows.filter((r) => readable.has(r.location_id)).map((r) => {
    const [m] = membershipRowsFromStudioRows([r])
    return {
      location_id: r.location_id,
      kind: r.kind,
      status: r.status,
      source: r.source,
      membership: m ? { plan: m.plan_name, status: m.status, since: m.first_seen_at, ended_at: m.ended_at } : null,
    }
  })
}

async function readDeals(db, contactId) {
  const { data, error } = await db.from('deals')
    .select('id, title, status, stage_entered_at, pipelines(name), pipeline_stages(name)')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(MAX_DEALS)
  if (error) throw failed('deals', error)
  return (data || []).map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    pipeline: d.pipelines?.name ?? null,
    stage: d.pipeline_stages?.name ?? null,
    stage_entered_at: d.stage_entered_at,
  }))
}

async function readTimeline(db, contactId) {
  const [notes, activities] = await Promise.all([
    db.from('notes')
      .select('id, content, created_at')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(TIMELINE_ROWS),
    db.from('activities')
      .select('id, type, subject, created_at')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(TIMELINE_ROWS),
  ])
  if (notes.error) throw failed('notes', notes.error)
  if (activities.error) throw failed('activities', activities.error)
  return mergeTimeline(notes.data, activities.data).slice(0, TIMELINE_ROWS).map((item) => ({
    date: item.date,
    activityType: item.activityType,
    subject: item.activityType === 'note' ? String(item.content ?? '').slice(0, NOTE_CHARS) : (item.subject ?? null),
  }))
}

async function readBookings(db, contactId, nowMs) {
  const { data, error } = await db.from('class_bookings')
    .select('starts_at, class_name, status, attended, source_platform')
    .eq('contact_id', contactId)
    .gte('starts_at', new Date(nowMs - BOOKING_WINDOW_MS).toISOString())
    .lte('starts_at', new Date(nowMs + BOOKING_WINDOW_MS).toISOString())
    .order('starts_at', { ascending: true })
    .limit(MAX_BOOKINGS)
  if (error) throw failed('class bookings', error)
  return (data || []).map((b) => ({
    starts_at: b.starts_at, class_name: b.class_name, status: b.status, attended: b.attended, platform: b.source_platform,
  }))
}

export default defineTool({
  name: 'get_contact',
  title: 'Contact',
  description: 'One contact (get the id from search_contacts): details, studios with membership, deals, '
    + 'the 20 most recent notes and activities (subjects only, no message text), and class bookings from '
    + '30 days back to 30 days ahead (instants in UTC). Needs the Contacts permission at a studio of this organisation the contact belongs to.',
  inputSchema: z.object({
    studio_id: z.string().uuid().optional().describe('A studio id; omit for the default studio.'),
    contact_id: z.string().uuid().describe('The contact (search_contacts).'),
  }),
  // At least one studio of the resolved studio's organisation where contacts may be read.
  gate: (user, _studioId, ctx) => readableContactStudios(user, ctx).length > 0,
  run: async (input, ctx) => {
    const { db, user, nowMs } = ctx
    const at = await contactReadableAt(db, user, input.contact_id, ctx)
    if (!at) throw new ToolRefusal('not_found', 'Contact not found.')

    const [contact, studios, deals, timeline, classBookings] = await Promise.all([
      readContact(db, input.contact_id),
      readStudios(db, user, input.contact_id, ctx),
      readDeals(db, input.contact_id),
      readTimeline(db, input.contact_id),
      readBookings(db, input.contact_id, nowMs),
    ])
    if (!contact) throw new ToolRefusal('not_found', 'Contact not found.')
    return { contact, studios, deals, timeline, class_bookings: classBookings }
  },
})
