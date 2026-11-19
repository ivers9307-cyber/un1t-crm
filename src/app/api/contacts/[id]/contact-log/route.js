// POST /api/contacts/[id]/contact-log — CONTACTLOG.1: log a contact on the
// timeline.
//
// One click from the board card, the board drawer or the contact page: the
// channel (call, WhatsApp, email), whether it got through, and an optional
// note become a `contact_log` activity at the studio the caller is working in
// (src/lib/contact-log.js). That row is what takes the card off the board's
// "Not contacted" filter.
//
// The gate is the task form's (POST /api/activities/tasks), since both write
// `activities`: the web Tasks key AND Contacts at the body's studio
// (canWriteActivitiesAt), membership of that studio first (403, the
// body-location shape), and the contact must be AT that studio (its primary or
// a contact_studios row; 404 otherwise, so ids are not enumerable).
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { assertLocationAccess } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { activitiesWriteForbiddenAnywhere, taskWriteRefusalAt, taskLinksRefusal } from '@/lib/activity-web-writes'
import { CONTACT_CHANNELS, CONTACT_OUTCOMES, contactLogRow } from '@/lib/contact-log'

export const runtime = 'nodejs'

const LogContactSchema = z.object({
  location_id: uuidLike,
  channel: z.enum(Object.keys(CONTACT_CHANNELS)),
  outcome: z.enum(Object.keys(CONTACT_OUTCOMES)),
  note: z.string().trim().max(2_000).nullable().optional(),
})

// permission null: the Tasks key is judged at the BODY's studio below, as the
// task route judges it, never at the caller's active studio.
export const POST = withAuth(
  { permission: null, location: false, schema: LogContactSchema },
  async ({ user, db, input, params }) => {
    const id = params?.id
    if (!uuidLike.safeParse(id).success) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    const coarse = activitiesWriteForbiddenAnywhere(user)
    if (coarse) return coarse
    const notMember = assertLocationAccess(user, input.location_id)
    if (notMember) return notMember
    const refused = taskWriteRefusalAt(user, input.location_id)
    if (refused) return refused
    const linkRefusal = await taskLinksRefusal(db, { locationId: input.location_id, contactId: id })
    if (linkRefusal) return linkRefusal

    const row = contactLogRow({
      contactId: id,
      locationId: input.location_id,
      channel: input.channel,
      outcome: input.outcome,
      note: input.note,
      nowIso: new Date().toISOString(),
    })
    const { data, error } = await db.from('activities').insert(row).select('id, subject').single()
    if (error || !data) {
      return NextResponse.json({ success: false, error: 'Could not log the contact. Try again.' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data })
  },
)
