// Host event detail (HOST-PORTAL.1) — the roster for ONE of the host's events,
// plus an Export CSV button. Server-rendered + scoped: getCurrentHost() then
// race.host_id === host.id (notFound() otherwise, so ids can't be enumerated).
// Roster: one row per entry (attendee fetch shared with the CSV export via
// attendee-export), with a Move action per paid entry (EVENT-MOVE.2, the
// HostAttendeeTable client component + the /api/host/registrations/[id]/move*
// routes); the event's waitlist (EVENT-WAITLIST.1, read-only + Offer now) and a
// self-serve promo-codes section (HOST-PORTAL.9) sit below.
// Header actions include take-off-sale / delete (HOST-PORTAL.10).

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { fetchEventAttendees } from '@/lib/attendee-export'
import { loadMoveHistory } from '@/lib/registration-move-history'
import { entryLabel } from '@/lib/registration-entry'
import { resolveRegistrationQuestions, answersForDisplay } from '@/lib/registration-questions'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import HostAttendeeTable from '@/components/host/HostAttendeeTable'
import HostPromoCodes from '@/components/host/HostPromoCodes'
import HostEventActions from '@/components/host/HostEventActions'
import DuplicateEventButton from '@/components/DuplicateEventButton'
import HostSeriesActions from '@/components/host/HostSeriesActions'
import EventWaitlistPanel from '@/components/EventWaitlistPanel'
import EventSignupsCard from '@/components/EventSignupsCard'
import HostEventRatings from '@/components/host/HostEventRatings'
import { loadEventStats } from '@/lib/event-stats'

export const dynamic = 'force-dynamic'

export default async function HostEventDetail(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, host_id, status, name, slug, race_date, series_id, registration_questions, series:event_series ( id, name, slug )')
    .eq('id', params.id)
    .maybeSingle()
  if (!race || race.host_id !== session.host.id) notFound()
  const brand = await resolveHostOrgBrand(db, session.host)

  const regs = await fetchEventAttendees(db, params.id)
  // HOSTSTATS.1 — views, visitors, bookings, sources, waitlist. A failed read
  // shows the card's unavailable copy; the rest of the page still renders.
  const statsRes = await loadEventStats(db, params.id)
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
  const confirmed = regs.filter((r) => r.status === 'confirmed').length
  // People, as the old one-row-per-person table counted them: a member-less
  // entry still counts as one.
  const people = entries.reduce((n, e) => n + Math.max(1, e.people.length), 0)

  return (
    <div>
      <a href="/host" className="text-xs text-white/45 hover:text-white">← Back</a>

      <div className="mt-3 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold truncate">{race.name}</h1>
          <p className="text-white/55 text-sm mt-1">
            {race.race_date || '—'} · {regs.length} booking{regs.length === 1 ? '' : 's'} · {confirmed} confirmed · {people} attendee{people === 1 ? '' : 's'}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
          {regs.length > 0 && (
            <a
              href={`/api/host/events/${race.id}/attendees/export`}
              className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90"
            >
              Export CSV
            </a>
          )}
          {/* HOSTSERIES.1 — copy this event to a new date as a draft. */}
          <DuplicateEventButton
            eventId={race.id}
            raceDate={race.race_date}
            apiUrl={`/api/host/events/${race.id}/duplicate`}
            editHrefFor={(id) => `/host/events/${id}/edit`}
            dark
          />
          <HostEventActions eventId={race.id} status={race.status} hasRegistrations={regs.length > 0} brandName={brand.name} />
        </div>
      </div>

      {/* HOSTSTATS.1 — how the signup page is doing. */}
      <EventSignupsCard stats={statsRes.ok ? statsRes.stats : null} dark />

      {/* HOSTSERIES.1 — make this event a series, or show the series it is in. */}
      <div className="mt-4">
        <HostSeriesActions
          eventId={race.id}
          eventName={race.name}
          raceDate={race.race_date}
          seriesId={race.series_id || null}
          seriesName={race.series?.name || ''}
          seriesSlug={race.series?.slug || ''}
        />
      </div>

      <HostAttendeeTable entries={entries} movedOut={movedOut} />

      {/* EVENT-WAITLIST.1 — read-only list + Offer now (own events only). */}
      <EventWaitlistPanel
        dark
        listUrl={`/api/host/events/${race.id}/waitlist`}
        offerUrl={`/api/host/events/${race.id}/waitlist/offer`}
      />

      <HostPromoCodes eventId={race.id} />

      {/* HOSTPAGE.2 — attendee ratings, with Hide/Show per rating. */}
      <HostEventRatings eventId={race.id} />
    </div>
  )
}
