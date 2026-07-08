// Host event detail (HOST-PORTAL.1) — the roster for ONE of the host's events,
// plus an Export CSV button. Server-rendered + scoped: getCurrentHost() then
// race.host_id === host.id (notFound() otherwise, so ids can't be enumerated).
// Read-only. Attendee fetch is shared with the CSV export via attendee-export.

import { notFound, redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { fetchEventAttendees } from '@/lib/attendee-export'

export const dynamic = 'force-dynamic'

const STATUS_LABEL = {
  confirmed: 'Confirmed',
  pending_payment: 'Pending',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

export default async function HostEventDetail(props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, host_id, name, slug, race_date')
    .eq('id', params.id)
    .maybeSingle()
  if (!race || race.host_id !== session.host.id) notFound()

  const regs = await fetchEventAttendees(db, params.id)

  // Flatten to one row per person (mirrors the CSV export exactly).
  const rows = []
  for (const reg of regs) {
    const team = reg.teams || {}
    const wave = reg.wave || {}
    const waveLabel = wave.label || wave.start_time || '—'
    const phone = reg.payment?.contact_phone || ''
    const members = Array.isArray(team.team_members) ? team.team_members : []
    if (members.length === 0) {
      rows.push({ key: reg.id, team: team.name || '—', wave: waveLabel, status: reg.status, name: '—', email: '', phone })
    } else {
      for (const m of members) {
        rows.push({
          key: `${reg.id}:${m.id}`,
          team: team.name || '—',
          wave: waveLabel,
          status: reg.status,
          name: m.name || '—',
          email: m.email || '',
          phone,
        })
      }
    }
  }
  const confirmed = regs.filter((r) => r.status === 'confirmed').length

  const th = 'px-3 py-2 font-medium'
  const td = 'px-3 py-2'

  return (
    <div>
      <a href="/host" className="text-xs text-white/45 hover:text-white">← Back</a>

      <div className="mt-3 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold truncate">{race.name}</h1>
          <p className="text-white/55 text-sm mt-1">
            {race.race_date || '—'} · {regs.length} booking{regs.length === 1 ? '' : 's'} · {confirmed} confirmed · {rows.length} attendee{rows.length === 1 ? '' : 's'}
          </p>
        </div>
        {rows.length > 0 && (
          <a
            href={`/api/host/events/${race.id}/attendees/export`}
            className="shrink-0 rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90"
          >
            Export CSV
          </a>
        )}
      </div>

      <section className="mt-8">
        {rows.length === 0 ? (
          <p className="text-white/50 text-sm">No attendees yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                  <th className={th}>Name</th>
                  <th className={th}>Team</th>
                  <th className={th}>Wave</th>
                  <th className={th}>Status</th>
                  <th className={th}>Email</th>
                  <th className={th}>Phone</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-white/5 last:border-0">
                    <td className={td}>{r.name}</td>
                    <td className={`${td} text-white/70`}>{r.team}</td>
                    <td className={`${td} text-white/70`}>{r.wave}</td>
                    <td className={`${td} text-white/70`}>{STATUS_LABEL[r.status] || r.status}</td>
                    <td className={`${td} text-white/60`}>{r.email}</td>
                    <td className={`${td} text-white/60`}>{r.phone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
