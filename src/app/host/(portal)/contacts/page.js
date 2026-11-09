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
import { failureCopy } from '@/lib/host-campaign-outcome'
import { HOST_BTN_PRIMARY, HOST_CHIP, HOST_CHIP_TONE, HOST_H1, HOST_HINT, HOST_META, HOST_TD, HOST_TH } from '@/components/host/host-ui'

export const dynamic = 'force-dynamic'

const SOURCE_LABEL = { event: 'Event', mailing_list: 'Mailing list' }

export default async function HostContacts() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const rows = await fetchHostContactRows(db, session.host.id)
  const emailableCount = rows.filter((r) => r.emailable).length

  const th = HOST_TH
  const td = HOST_TD

  return (
    <div>
      <a href="/host" className="text-xs text-host-hint hover:text-host-text">← Back</a>

      <div className="mt-3 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className={HOST_H1}>Contacts</h1>
          <p className="text-host-hint text-sm mt-1">
            {rows.length} contact{rows.length === 1 ? '' : 's'} · {emailableCount} emailable
          </p>
        </div>
        {rows.length > 0 && (
          <a
            href="/api/host/contacts/export"
            className={`shrink-0 ${HOST_BTN_PRIMARY}`}
          >
            Export CSV
          </a>
        )}
      </div>

      <section className="mt-8">
        {rows.length === 0 ? (
          <p className={HOST_HINT}>
            No contacts yet — they&apos;re added automatically when someone books one of your events.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-host-border">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr>
                  <th className={th}>Name</th>
                  <th className={th}>Email</th>
                  <th className={th}>Source</th>
                  <th className={th}>Joined</th>
                  <th className={th}>Emailable</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.contact_id}>
                    <td className={td}>{r.name || '—'}</td>
                    <td className={`${td} text-host-hint`}>{r.email || '—'}</td>
                    <td className={`${td} text-host-label`}>{SOURCE_LABEL[r.source] || r.source}</td>
                    <td className={`${td} text-host-hint`}>{r.created_at ? r.created_at.slice(0, 10) : '—'}</td>
                    <td className={td}>
                      <span
                        className={`${HOST_CHIP} ${r.emailable ? HOST_CHIP_TONE.ok : HOST_CHIP_TONE.neutral}`}
                      >
                        {r.emailable ? 'Emailable' : 'No'}
                      </span>
                      {!r.emailable && r.emailable_reason && (
                        <p className={`${HOST_META} mt-1`}>{failureCopy(r.emailable_reason)}</p>
                      )}
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
