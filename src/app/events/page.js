// /events — operator index of events at the active location.
// Multi-kind from mig 122 (race + workshop + seminar + open_day +
// masterclass). Same race_events table, kind discriminator drives
// per-row visual differences (kind pill) + which actions show
// (e.g. "Race day" link is race-only).

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { MANAGER_ROLES } from '@/lib/schemas'
import { Plus, Flag, ExternalLink, Users } from 'lucide-react'
import { getAppUrl } from '@/lib/app-url'

export const dynamic = 'force-dynamic'
export const revalidate = 0

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
}
const kindBadge = (k) => KIND_BADGE[k] || KIND_BADGE.race

export default async function EventsIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')
  // Permission key 'races' kept internally — it gates UI for the
  // entire multi-kind events feature (mig 092 audit; renaming the
  // key would cascade to every per-role default + every location's
  // saved overrides, not worth the churn).
  if (!hasPermission(user, 'races')) redirect('/')

  const db = createServerClient()
  const locationIds = getUserLocationIds(user)
  let races = []
  if (locationIds.length > 0) {
    const { data } = await db
      .from('race_events')
      .select(`
        id, name, slug, race_date, start_time, capacity, allowed_team_sizes,
        active, kind, registration_opens_at, registration_closes_at,
        registrations:race_registrations ( id, status )
      `)
      .in('location_id', locationIds)
      .order('race_date', { ascending: false })
    races = data || []
  }

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
          className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
        >
          <Plus size={12} /> New event
        </Link>
      </div>
      <p className="text-sm text-un1t-light mb-8">
        Standalone events at this location — races (Hyrox sims with race-day timing + TV display), workshops, seminars, open days, masterclasses. Customers register via a dedicated public signup page; per-seat name + email is captured for every event kind.
      </p>

      {races.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8 text-center">
          <Flag size={28} className="mx-auto text-un1t-light mb-3" />
          <p className="text-sm text-un1t-light mb-4">No events yet.</p>
          <Link
            href="/events/new"
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Create the first one
          </Link>
        </div>
      ) : (
        <>
          {/* Desktop / tablet: original table — hidden below md so
              phones don't horizontal-scroll a 6-column grid. */}
          <div className="hidden md:block bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-un1t-gray text-un1t-light text-[11px] uppercase tracking-wider">
                  <th className="text-left p-3">Event</th>
                  <th className="text-left p-3">Type</th>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">Signups</th>
                  <th className="text-left p-3">Sizes</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-un1t-gray">
                {races.map((r) => {
                  const confirmedCount = (r.registrations || []).filter(x => x.status === 'confirmed').length
                  const publicUrl = appOrigin ? `${appOrigin}/event/${r.slug}` : `/event/${r.slug}`
                  const isRace = (r.kind || 'race') === 'race'
                  const badge = kindBadge(r.kind || 'race')
                  return (
                    <tr key={r.id} className="hover:bg-un1t-gray/20">
                      <td className="p-3">
                        <div className="font-medium text-un1t-white">{r.name}</div>
                        <div className="text-[11px] text-un1t-light font-mono mt-0.5">/{r.slug}</div>
                      </td>
                      <td className="p-3">
                        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="p-3 text-un1t-light whitespace-nowrap">
                        {r.race_date}
                        {r.start_time && <span className="text-[11px] text-un1t-mid ml-1">@ {r.start_time.slice(0, 5)}</span>}
                      </td>
                      <td className="p-3 text-un1t-light">
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} /> {confirmedCount}{r.capacity ? ` / ${r.capacity}` : ''}
                        </span>
                      </td>
                      <td className="p-3 text-un1t-light text-xs">
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
                            className="text-[11px] text-un1t-light hover:text-un1t-white inline-flex items-center gap-1"
                          >
                            Public <ExternalLink size={10} />
                          </a>
                          <Link
                            href={`/events/${r.id}/teams`}
                            className="text-[11px] text-un1t-light hover:text-un1t-white"
                            title={isRace ? 'View + manage registered teams' : 'View + manage registered attendees'}
                          >
                            {isRace ? 'Teams' : 'Attendees'}
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
                            className="text-[11px] text-un1t-light hover:text-un1t-white"
                            title="Download a printable QR code that links to the public signup page"
                          >
                            QR
                          </a>
                          <Link
                            href={`/events/${r.id}/edit`}
                            className="text-[11px] text-un1t-light hover:text-un1t-white"
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
              const confirmedCount = (r.registrations || []).filter(x => x.status === 'confirmed').length
              const publicUrl = appOrigin ? `${appOrigin}/event/${r.slug}` : `/event/${r.slug}`
              const isRace = (r.kind || 'race') === 'race'
              const badge = kindBadge(r.kind || 'race')
              return (
                <div
                  key={r.id}
                  className="bg-un1t-dark border border-un1t-gray rounded-lg p-4"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-un1t-white">{r.name}</div>
                      <div className="text-[11px] text-un1t-light font-mono mt-0.5">/{r.slug}</div>
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
                  <div className="flex items-center gap-3 text-xs text-un1t-light mb-3">
                    <span className="whitespace-nowrap">
                      {r.race_date}
                      {r.start_time && <span className="text-un1t-mid"> · {r.start_time.slice(0, 5)}</span>}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users size={11} /> {confirmedCount}{r.capacity ? ` / ${r.capacity}` : ''}
                    </span>
                    {(r.allowed_team_sizes || []).length > 0 && (
                      <span className="text-un1t-mid">
                        {(r.allowed_team_sizes || []).join(', ')}
                      </span>
                    )}
                  </div>
                  {/* Action row — distinct tap targets. For races the
                      day-of operator path is highlighted in blue
                      (highest-frequency mobile use). For non-race
                      kinds we drop the Race-day button. */}
                  <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-un1t-gray text-xs">
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
                      className="px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light"
                    >
                      {isRace ? 'Teams' : 'Attendees'}
                    </Link>
                    <Link
                      href={`/events/${r.id}/edit`}
                      className="px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light"
                    >
                      Edit
                    </Link>
                    <a
                      href={publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto px-3 py-1.5 rounded-md text-un1t-light inline-flex items-center gap-1"
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
