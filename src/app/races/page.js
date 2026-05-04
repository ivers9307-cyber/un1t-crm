// /races — operator index of race events at the active location.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { Plus, Flag, ExternalLink, Users } from 'lucide-react'
import { getAppUrl } from '@/lib/app-url'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function RacesIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!MANAGER_ROLES.includes(user.role)) redirect('/')

  const db = createServerClient()
  const locationIds = getUserLocationIds(user)
  let races = []
  if (locationIds.length > 0) {
    const { data } = await db
      .from('race_events')
      .select(`
        id, name, slug, race_date, start_time, capacity, allowed_team_sizes,
        active, registration_opens_at, registration_closes_at,
        registrations:race_registrations ( id, status )
      `)
      .in('location_id', locationIds)
      .order('race_date', { ascending: false })
    races = data || []
  }

  let appUrl = ''
  try { appUrl = getAppUrl() } catch {}

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-2">
        <h2 className="text-2xl font-bold">Race events</h2>
        <Link
          href="/races/new"
          className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
        >
          <Plus size={12} /> New race
        </Link>
      </div>
      <p className="text-sm text-un1t-light mb-8">
        Standalone race occurrences (Hyrox sims, etc). Teams register via a dedicated public signup
        page; the race-day operator UI lets you start and finish each team&apos;s timer.
      </p>

      {races.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8 text-center">
          <Flag size={28} className="mx-auto text-un1t-light mb-3" />
          <p className="text-sm text-un1t-light mb-4">No race events yet.</p>
          <Link
            href="/races/new"
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Create the first one
          </Link>
        </div>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-un1t-gray text-un1t-light text-[11px] uppercase tracking-wider">
                <th className="text-left p-3">Race</th>
                <th className="text-left p-3">Date</th>
                <th className="text-left p-3">Teams</th>
                <th className="text-left p-3">Sizes</th>
                <th className="text-left p-3">Status</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-un1t-gray">
              {races.map((r) => {
                const confirmedCount = (r.registrations || []).filter(x => x.status === 'confirmed').length
                const publicUrl = appUrl ? `${appUrl}/race/${r.slug}` : `/race/${r.slug}`
                return (
                  <tr key={r.id} className="hover:bg-un1t-gray/20">
                    <td className="p-3">
                      <div className="font-medium text-un1t-white">{r.name}</div>
                      <div className="text-[11px] text-un1t-light font-mono mt-0.5">/{r.slug}</div>
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
                          href={`/races/${r.id}/control`}
                          className="text-[11px] text-blue-700 hover:text-blue-800"
                        >
                          Race day
                        </Link>
                        <Link
                          href={`/races/${r.id}/edit`}
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
      )}
    </div>
  )
}
