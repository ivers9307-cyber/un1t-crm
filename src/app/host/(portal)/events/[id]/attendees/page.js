// Attendees tab of a host's event page (HOSTPORTAL.2): the roster, the Export
// CSV link and the waitlist. The layout above renders the header and tab strip;
// this page repeats the gate (getCurrentHost + loadHostEvent) because a layout
// is never the only gate. Only JSON-safe plain objects cross into the client
// table.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { loadHostEvent, attendeeCounts } from '@/lib/host-portal'
import { fetchEventAttendees } from '@/lib/attendee-export'
import { loadMoveHistory } from '@/lib/registration-move-history'
import { entryLabel } from '@/lib/registration-entry'
import { resolveRegistrationQuestions, answersForDisplay } from '@/lib/registration-questions'
import HostAttendeeTable from '@/components/host/HostAttendeeTable'
import EventWaitlistPanel from '@/components/EventWaitlistPanel'
import { HOST_BTN_PRIMARY } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

export default async function HostEventAttendees(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const race = await loadHostEvent(db, session.host.id, params.id, 'id, host_id, registration_questions')
  if (!race) notFound()

  const regs = await fetchEventAttendees(db, params.id)
  const { lastMoveByReg, movedOut } = await loadMoveHistory(db, { eventId: params.id, regIds: regs.map((r) => r.id) })

  // QUESTIONS.1 — answers as label/value rows for the table.
  const questions = resolveRegistrationQuestions(race)
  const entryQuestions = questions.filter((q) => q.per !== 'person')
  const personQuestions = questions.filter((q) => q.per === 'person')
  // One row per ENTRY (a team or a single person), people listed in a cell.
  // Only JSON-safe plain objects cross into the client table.
  const entries = regs.map((reg) => {
    const members = Array.isArray(reg.teams?.team_members) ? reg.teams.team_members : []
    const moveIn = lastMoveByReg[reg.id]
    return {
      id: reg.id,
      status: reg.status,
      label: entryLabel(reg),
      people: members.map((m) => ({ name: m.name || '', email: m.email || '', answers: answersForDisplay(personQuestions, null, m.answers) })),
      answers: answersForDisplay(entryQuestions, reg.answers, null),
      wave: reg.wave?.label || (reg.wave?.start_time || '').slice(0, 5) || '',
      phone: reg.payment?.contact_phone || '',
      last_move: moveIn
        ? { created_at: moveIn.created_at, actor_name: moveIn.actor_name, forced: moveIn.forced, notified_at: moveIn.notified_at, from_event: moveIn.from_event || null }
        : null,
      // What the dialog needs to label the entry before the targets load
      // (entryLabel's inputs only; emails travel in `people`).
      registration: {
        id: reg.id,
        status: reg.status,
        teams: reg.teams
          ? { name: reg.teams.name, size: reg.teams.size, team_members: members.map((m) => ({ name: m.name, role: m.role })) }
          : null,
        contact: reg.contact ? { first_name: reg.contact.first_name, last_name: reg.contact.last_name } : null,
      },
    }
  })
  const { bookings, confirmed, people } = attendeeCounts(regs)

  return (
    <div>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-host-hint text-sm">
          {bookings} booking{bookings === 1 ? '' : 's'} · {confirmed} confirmed · {people} attendee{people === 1 ? '' : 's'}
        </p>
        {regs.length > 0 && (
          <a
            href={`/api/host/events/${race.id}/attendees/export`}
            className={HOST_BTN_PRIMARY}
          >
            Export CSV
          </a>
        )}
      </div>

      <HostAttendeeTable entries={entries} movedOut={movedOut} />

      {/* EVENT-WAITLIST.1 — read-only list + Offer now (own events only). */}
      <EventWaitlistPanel
        dark
        listUrl={`/api/host/events/${race.id}/waitlist`}
        offerUrl={`/api/host/events/${race.id}/waitlist/offer`}
      />
    </div>
  )
}
