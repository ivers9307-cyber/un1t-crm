// /events — operator index of events at the active location.
// Multi-kind from mig 122 (race + workshop + seminar + open_day +
// masterclass). Same race_events table, kind discriminator drives
// per-row visual differences (kind pill) + which actions show
// (e.g. "Race day" link is race-only).

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { Plus, Flag, ExternalLink, Users } from 'lucide-react'
import { getAppUrl } from '@/lib/app-url'
import { formatSignupSummary, sumWaveCapacity } from '@/lib/event-signups'

export const dynamic = 'force-dynamic'

// Kind label + colour map. Per-kind pill uses these on the index.
// Race uses the existing emerald pillstyling, others get muted blues
// / purples / ambers / pinks so workshops vs masterclasses are
// visually distinct at a glance.
const KIND_BADGE = {
  race:        { label: 'Race',        cls: 'bg-emerald-500/15 text-emerald-700' },
  workshop:    { label: 'Workshop',    cls: 'bg-sky-500/15 text-sky-700' },
  seminar:     { label: 'Seminar',     cls: 'bg-indigo-500/15 text-indigo-700' },
  open_day:    { label: 'Open day',    cls: 'bg-amber-500/15 text-amber-700' },
  masterclass: { label: 'Masterclass', cls: 'bg-pink-500/15 text-pink-700' },
  lead_gen:    { label: 'Lead Gen',    cls: 'bg-teal-500/15 text-teal-700' },
}
const kindBadge = (k) => KIND_BADGE[k] || KIND_BADGE.race

// Today in YYYY-MM-DD (Europe/Dublin) — used to split events into
// upcoming vs past tabs. Server-side renders against THIS date so the
// boundary doesn't shift mid-page-render. Anything dated today counts
// as upcoming (race day is the day OF the event).
function todayIsoDublin() {
  // Dublin is UTC+0/+1 depending on DST. The simplest correct way to
  // get "today's date as the operator sees it" is to format via Intl
  // in the Dublin tz. Returns YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

export default async function EventsIndexPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Permission key 'races' kept internally — it gates UI for the
  // entire multi-kind events feature (mig 092 audit; renaming the
  // key would cascade to every per-role default + every location's
  // saved overrides, not worth the churn).
  if (!hasPermission(user, 'races')) redirect('/')

  // Tab selection via ?tab=upcoming|past. Defaults to upcoming so
  // operators land on what's actionable, not on history.
  const rawTab = searchParams?.tab
  const tab = rawTab === 'past' ? 'past' : 'upcoming'

  const db = createServerClient()
  // EVENTS-LOC.2 — scope the list to the operator's ACTIVE location so
  // each studio is independent (Hatch Street must not see Stillorgan's
  // events), PLUS any event flagged `shared` (owned by one location but
  // surfaced at every location). Master switches active location via the
  // location switcher; non-master operators are pinned to theirs. No
  // active location → empty list rather than leaking every location.
  const activeLocationId = user.activeLocation?.id || null
  let races = []
  if (activeLocationId) {
    const { data } = await db
      .from('race_events')
      .select(`
        id, name, slug, race_date, start_time, capacity, capacity_mode, allowed_team_sizes,
        active, kind, shared, location_id, registration_opens_at, registration_closes_at,
        waves:race_waves ( capacity ),
        registrations:race_registrations ( id, status, team:teams ( size ) )
      `)
      .or(`location_id.eq.${activeLocationId},shared.eq.true`)
      .order('race_date', { ascending: false })
    races = data || []
  }

  // Split into upcoming (race_date >= today) and past (race_date <
  // today). Anything with no race_date defaults to upcoming so a
  // half-created event doesn't get hidden in the past tab.
  const today = todayIsoDublin()
  const upcoming = races.filter((r) => !r.race_date || r.race_date >= today)
  const past     = races.filter((r) => r.race_date && r.race_date < today)

  // Upcoming sorts by date ASC (next event first); past stays DESC
  // (most recent past at top of the history list).
  upcoming.sort((a, b) => (a.race_date || '').localeCompare(b.race_date || ''))
  // past is already DESC from the SQL order

  const visible = tab === 'past' ? past : upcoming
  const tabs = [
    { id: 'upcoming', label: 'Upcoming', count: upcoming.length, href: '/events' },
    { id: 'past',     label: 'Past',     count: past.length,     href: '/events?tab=past' },
  ]

  let appOrigin = ''
  try {
    const raw = getAppUrl()
    appOrigin = new URL(raw).origin
  } catch {
    appOrigin = ''
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-2">
        <h2 className="text-2xl font-bold">Events</h2>
        <Link
          href="/events/new"
          className="inline-flex items-center gap-1.5 text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
        >
          <Plus size={12} /> New event
        </Link>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        Standalone events at this location — races (Hyrox sims with race-day timing + TV display), workshops, seminars, open days, masterclasses. Customers register via a dedicated public signup page; per-seat name + email is captured for every event kind.
      </p>

      {/* Upcoming / Past tab strip. Server-rendered via ?tab= search
          param — full page reload on switch but data is small and the
          UX is "I want to see history" rather than "rapid back-and-
          forth". Keeps the page a pure server component. */}
      <div className="flex items-center gap-1 mb-5 border-b border-un1t-border">
        {tabs.map((t) => {
          const active = tab === t.id
          return (
            <Link
              key={t.id}
              href={t.href}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px ${
                active
                  ? 'border-un1t-text text-un1t-text font-medium'
                  : 'border-transparent text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {t.label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                active ? 'bg-un1t-text/15 text-un1t-text' : 'bg-un1t-border/40 text-un1t-subtle'
              }`}>{t.count}</span>
            </Link>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
          <Flag size={28} className="mx-auto text-un1t-subtle mb-3" />
          <p className="text-sm text-un1t-subtle mb-4">
            {tab === 'past'
              ? 'No past events yet.'
              : 'No upcoming events. Create one to get started.'}
          </p>
          {tab === 'upcoming' && (
            <Link
              href="/events/new"
              className="inline-flex items-center gap-1.5 text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
            >
              <Plus size={12} /> Create the first one
            </Link>
          )}
        </div>
      ) : (
        <>
          {/* Desktop / tablet: original table — hidden below md so
              phones don't horizontal-scroll a 6-column grid. */}
          <div className="hidden md:block bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-un1t-border text-un1t-subtle text-[11px] uppercase tracking-wider">
                  <th className="text-left p-3">Event</th>
                  <th className="text-left p-3">Type</th>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">Signups</th>
                  <th className="text-left p-3">Sizes</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-un1t-border">
                {visible.map((r) => {
                  const publicUrl = appOrigin ? `${appOrigin}/event/${r.slug}` : `/event/${r.slug}`
                  const isRace = (r.kind || 'race') === 'race'
                  const badge = kindBadge(r.kind || 'race')
                  const signupSummary = formatSignupSummary(r.registrations, { isRace, capacity: sumWaveCapacity(r.waves) ?? r.capacity, mode: r.capacity_mode })
                  return (
                    <tr key={r.id} className="hover:bg-un1t-border/20">
                      <td className="p-3">
                        <div className="font-medium text-un1t-text">{r.name}</div>
                        {r.shared && <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-700">Shared</span>}
                        <div className="text-[11px] text-un1t-subtle font-mono mt-0.5">/{r.slug}</div>
                      </td>
                      <td className="p-3">
                        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="p-3 text-un1t-subtle whitespace-nowrap">
                        {r.race_date}
                        {r.start_time && <span className="text-[11px] text-un1t-muted ml-1">@ {r.start_time.slice(0, 5)}</span>}
                      </td>
                      <td className="p-3 text-un1t-subtle">
                        <span className="inline-flex items-center gap-1 whitespace-nowrap">
                          <Users size={11} /> {signupSummary}
                        </span>
                      </td>
                      <td className="p-3 text-un1t-subtle text-xs">
                        {(r.allowed_team_sizes || []).join(', ')}
                      </td>
                      <td className="p-3">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${r.active ? 'bg-emerald-500/15 text-emerald-700' : 'bg-gray-500/15 text-gray-700'}`}>
                          {r.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-3">
                          <a
                            href={publicUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
                          >
                            Public <ExternalLink size={10} />
                          </a>
                          <Link
                            href={`/events/${r.id}/teams`}
                            className="text-[11px] text-un1t-subtle hover:text-un1t-text"
                            title={isRace ? 'View + manage registered teams' : 'View + manage registered attendees'}
                          >
                            {isRace ? 'Teams' : 'Attendees'}
                          </Link>
                          <Link
                            href={`/events/${r.id}/checkin`}
                            className="text-[11px] text-un1t-subtle hover:text-un1t-text"
                            title="Check in attendees at the door"
                          >
                            Check in
                          </Link>
                          {/* Race-day control panel is race-only —
                              there's no equivalent for workshop /
                              seminar etc. (no live timing). E7 hides
                              the link for non-race kinds; the page
                              itself also redirects if hit directly. */}
                          {isRace && (
                            <Link
                              href={`/events/${r.id}/control`}
                              className="text-[11px] text-blue-700 hover:text-blue-800"
                            >
                              Race day
                            </Link>
                          )}
                          <a
                            href={`/api/events/${r.id}/qr-code`}
                            download
                            className="text-[11px] text-un1t-subtle hover:text-un1t-text"
                            title="Download a printable QR code that links to the public signup page"
                          >
                            QR
                          </a>
                          <Link
                            href={`/events/${r.id}/edit`}
                            className="text-[11px] text-un1t-subtle hover:text-un1t-text"
                          >
                            Edit
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: card list. Same data restacked — header row
              with name + status, sub-row with date + signup count,
              footer row with action links spaced for tap targets. */}
          <div className="md:hidden space-y-2">
            {races.map((r) => {
              const publicUrl = appOrigin ? `${appOrigin}/event/${r.slug}` : `/event/${r.slug}`
              const isRace = (r.kind || 'race') === 'race'
              const badge = kindBadge(r.kind || 'race')
              const signupSummary = formatSignupSummary(r.registrations, { isRace, capacity: sumWaveCapacity(r.waves) ?? r.capacity, mode: r.capacity_mode })
              return (
                <div
                  key={r.id}
                  className="bg-un1t-surface border border-un1t-border rounded-lg p-4"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-un1t-text">{r.name}</div>
                      {r.shared && <span className="inline-block mt-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-700">Shared</span>}
                      <div className="text-[11px] text-un1t-subtle font-mono mt-0.5">/{r.slug}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.cls}`}>
                        {badge.label}
                      </span>
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
                        r.active ? 'bg-emerald-500/15 text-emerald-700' : 'bg-gray-500/15 text-gray-700'
                      }`}>
                        {r.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-un1t-subtle mb-3">
                    <span className="whitespace-nowrap">
                      {r.race_date}
                      {r.start_time && <span className="text-un1t-muted"> · {r.start_time.slice(0, 5)}</span>}
                    </span>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <Users size={11} /> {signupSummary}
                    </span>
                    {(r.allowed_team_sizes || []).length > 0 && (
                      <span className="text-un1t-muted">
                        {(r.allowed_team_sizes || []).join(', ')}
                      </span>
                    )}
                  </div>
                  {/* Action row — distinct tap targets. For races the
                      day-of operator path is highlighted in blue
                      (highest-frequency mobile use). For non-race
                      kinds we drop the Race-day button. */}
                  <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-un1t-border text-xs">
                    {isRace && (
                      <Link
                        href={`/events/${r.id}/control`}
                        className="px-3 py-1.5 rounded-md bg-blue-600 text-white font-medium"
                      >
                        Race day
                      </Link>
                    )}
                    <Link
                      href={`/events/${r.id}/teams`}
                      className="px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle"
                    >
                      {isRace ? 'Teams' : 'Attendees'}
                    </Link>
                    <Link
                      href={`/events/${r.id}/checkin`}
                      className="px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle"
                    >
                      Check in
                    </Link>
                    <Link
                      href={`/events/${r.id}/edit`}
                      className="px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle"
                    >
                      Edit
                    </Link>
                    <a
                      href={publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto px-3 py-1.5 rounded-md text-un1t-subtle inline-flex items-center gap-1"
                    >
                      Public <ExternalLink size={10} />
                    </a>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
