// ORGCONTACTS.2 — the studios this person has a relationship with
// (contact_studios, mig 764; spec 2026-10-20 §2.1): the primary studio
// first, each with its kind (member > client > lead), status, source and
// first / last seen. Rendered next to the Glofox and studio-membership cards
// so an operator sees why a Stillorgan contact appears on Hatch's list.

import { RELATIONSHIP_SOURCE_LABELS } from '@/lib/contact-studios-display'
import { formatDate } from './format'
import ChangePrimaryStudio from './ChangePrimaryStudio'

const KIND_LABEL = { member: 'Member', client: 'Client', lead: 'Lead' }

// canRehome (ORGCONTACTS.4, decision 4): the page's gate for "Change primary
// studio" (the primary studio's admins, an organisation admin, a master);
// the control also needs another studio to move to.
export default function ContactStudiosCard({ studios, primaryLocationId, canRehome = false, contactId = null }) {
  if (!Array.isArray(studios) || studios.length === 0) return null
  const ordered = [...studios].sort((a, b) => Number(b.location_id === primaryLocationId) - Number(a.location_id === primaryLocationId))
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">Studios</h3>
      <ul className="space-y-2">
        {ordered.map((s) => {
          const active = s.status === 'active'
          const primary = s.location_id === primaryLocationId
          return (
            <li key={s.location_id} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-un1t-text">
                  {s.location?.name || 'Studio'}
                  {primary ? <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-700">Primary</span> : null}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-500/10 text-slate-700">{KIND_LABEL[s.kind] || s.kind}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${active ? 'bg-emerald-500/10 text-emerald-700' : 'bg-gray-500/10 text-gray-700'}`}>
                    {active ? 'Active' : 'Ended'}
                  </span>
                </span>
              </div>
              <div className="text-[11px] text-un1t-subtle">
                {RELATIONSHIP_SOURCE_LABELS[s.source] || s.source} · since {formatDate(s.first_seen_at)}
                {s.last_seen_at ? ` · last seen ${formatDate(s.last_seen_at)}` : ''}
              </div>
            </li>
          )
        })}
      </ul>
      {canRehome && contactId && studios.length > 1
        ? <ChangePrimaryStudio contactId={contactId} currentLocationId={primaryLocationId} studios={studios} />
        : null}
    </div>
  )
}
