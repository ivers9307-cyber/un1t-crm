// HATCH-MEMBERS.1 (mig 722) — memberships held outside Glofox (Hatch
// Street's un1t.online plans). Rendered only when the contact has one, next
// to the Glofox card, so an operator sees why this person prices as a member.

import { MEMBERSHIP_SOURCE_LABELS } from '@/lib/contact-memberships'
import { formatDate } from './format'

export default function StudioMembershipsCard({ memberships }) {
  if (!Array.isArray(memberships) || memberships.length === 0) return null
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">Studio membership</h3>
      <ul className="space-y-2">
        {memberships.map((m) => {
          const active = m.status === 'active'
          const source = MEMBERSHIP_SOURCE_LABELS[m.source] || m.source
          return (
            <li key={m.id} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-un1t-text">{m.plan_name}</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${active ? 'bg-emerald-500/10 text-emerald-700' : 'bg-gray-500/10 text-gray-700'}`}>
                  {active ? 'Active' : 'Ended'}
                </span>
              </div>
              <div className="text-[11px] text-un1t-subtle">
                {m.locations?.name || 'Studio'} · from the {source} export of {formatDate(m.last_seen_at)}
                {!active && m.ended_at ? ` · ended ${formatDate(m.ended_at)}` : ''}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-un1t-muted">Counts as a member for event pricing while active.</p>
    </div>
  )
}
