// Host dashboard (HOST-PORTAL.1, Phase 1 read-only). Server-rendered + scoped:
// getCurrentHost() → the host's own events via .eq('host_id', host.id).

import { redirect } from 'next/navigation'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export default async function HostDashboard() {
  const session = await getCurrentHost()
  if (!session) redirect('/host/login')

  const db = createServerClient()
  const { data: events } = await db
    .from('race_events')
    .select('id, name, slug, race_date, kind, active')
    .eq('host_id', session.host.id)
    .order('race_date', { ascending: false })
    .limit(200)
  const list = events || []
  const needsStripe = session.host.payment_provider === 'stripe_connect' && !session.host.charges_enabled

  return (
    <div>
      <h1 className="text-2xl font-bold">Welcome, {session.host.name}.</h1>
      <p className="text-white/60 mt-1 text-sm">Your events at a glance.</p>

      {needsStripe && (
        <div className="mt-6 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Your Stripe account isn&apos;t fully connected yet — ticket payments can&apos;t be taken until it is.
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Your events</h2>
        {list.length === 0 ? (
          <p className="text-white/50 text-sm">No events assigned to you yet.</p>
        ) : (
          <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
            {list.map((e) => (
              <li key={e.id} className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium truncate">{e.name}</p>
                  <p className="text-xs text-white/45">{e.race_date || '—'} · {e.kind}{e.active ? '' : ' · inactive'}</p>
                </div>
                <a href={`/event/${e.slug}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-white/50 hover:text-white">
                  View →
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-white/30 text-xs mt-10">
        Phase 1 — read-only. Revenue, attendee export, and self-serve event creation land next.
      </p>
    </div>
  )
}
