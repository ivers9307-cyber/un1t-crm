// Host contacts (HOST-EMAIL.1) — the host's OWN list: event participants
// (+ mailing-list signups from PR-B), with each contact's send-time
// emailability (host consent + bounce/complaint/unsubscribe flags +
// per-host suppression). Server-rendered + scoped: getCurrentHost() →
// fetchHostContactRows scopes every query to session.host.id. Read-only;
// Export CSV mirrors the roster page's export button.

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { fetchHostContactRows } from '@/lib/host-contact-list'

export const dynamic = 'force-dynamic'

const SOURCE_LABEL = { event: 'Event', mailing_list: 'Mailing list' }

export default async function HostContacts() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const rows = await fetchHostContactRows(db, session.host.id)
  const emailableCount = rows.filter((r) => r.emailable).length

  const th = 'px-3 py-2 font-medium'
  const td = 'px-3 py-2'

  return (
    <div>
      <a href="/host" className="text-xs text-white/45 hover:text-white">← Back</a>

      <div className="mt-3 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="text-white/55 text-sm mt-1">
            {rows.length} contact{rows.length === 1 ? '' : 's'} · {emailableCount} emailable
          </p>
        </div>
        {rows.length > 0 && (
          <a
            href="/api/host/contacts/export"
            className="shrink-0 rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90"
          >
            Export CSV
          </a>
        )}
      </div>

      <section className="mt-8">
        {rows.length === 0 ? (
          <p className="text-white/50 text-sm">
            No contacts yet — they&apos;re added automatically when someone books one of your events.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                  <th className={th}>Name</th>
                  <th className={th}>Email</th>
                  <th className={th}>Source</th>
                  <th className={th}>Joined</th>
                  <th className={th}>Emailable</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.contact_id} className="border-b border-white/5 last:border-0">
                    <td className={td}>{r.name || '—'}</td>
                    <td className={`${td} text-white/60`}>{r.email || '—'}</td>
                    <td className={`${td} text-white/70`}>{SOURCE_LABEL[r.source] || r.source}</td>
                    <td className={`${td} text-white/60`}>{r.created_at ? r.created_at.slice(0, 10) : '—'}</td>
                    <td className={td}>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                          r.emailable ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-white/60'
                        }`}
                      >
                        {r.emailable ? 'Emailable' : 'No'}
                      </span>
                    </td>
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
