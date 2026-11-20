// GET /api/events/[id]/raffle/contacts?q= — RAFFLE.1
//
// The till's buyer search: contacts with any relationship at the EVENT's
// studio (studio_contacts, the contacts-list rule), matched on name, email or
// phone. Phone matching uses the last nine digits against wa_phone, so
// "+353 87 123 4567" and "087 123 4567" find the same person. Read-only:
// nothing here, or anywhere in the raffle, writes a contact.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { resolveStaffRaffleEvent, phoneDigitsTail } from '@/lib/raffle'
import { listStudioContactsQuery } from '@/lib/studio-contacts-query'
import { escapeLikePattern } from '@/lib/like-escape'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PostgREST .or() uses commas and parentheses as syntax; a search token has
// no business carrying them.
const orSafe = (s) => String(s || '').replace(/[(),]/g, '')

export const GET = withAuth({ permission: null, location: false }, async ({ user, params, request }) => {
  const ctx = await resolveStaffRaffleEvent(user, params?.id)
  if (ctx.response) return ctx.response

  const q = orSafe(new URL(request.url).searchParams.get('q')).trim().slice(0, 100)
  if (q.length < 2) return NextResponse.json({ success: true, data: { contacts: [] } })

  const like = `%${escapeLikePattern(q)}%`
  const ors = [`name.ilike.${like}`, `email.ilike.${like}`]
  const tail = phoneDigitsTail(q)
  if (tail) ors.push(`wa_phone.ilike.%${tail}%`, `phone.ilike.%${escapeLikePattern(q)}%`)

  const { data, error } = await listStudioContactsQuery(ctx.db, {
    locationId: ctx.race.location_id, primaryOnly: true, columns: 'id, name, email, phone',
  }).or(ors.join(',')).order('name', { ascending: true }).limit(20)
  if (error) {
    logError('raffle', 'contact search failed', { err: error, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'Search failed. Try again.' }, { status: 500 })
  }
  const contacts = (data || []).map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone }))
  return NextResponse.json({ success: true, data: { contacts } })
})
