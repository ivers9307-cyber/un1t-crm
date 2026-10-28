// CARDLENS.8 — one studio's membership, in the left rail, for a person with a
// relationship at two or more studios (a one-studio person keeps the old
// cards). The card follows the studio's platform:
//   glofox      → the full Glofox card (plan, billing, bookings, sign-up
//                 answers, Create in Glofox), in the page's glofoxCardMode
//   un1t_online → that studio's facts (studioMemberships) and what
//                 un1t.online says is owed and paid (Un1tPaymentsCard's block)
//   none        → one line: no membership system at this studio
import GlofoxProfileCard from './GlofoxProfileCard'
import { StudioBlock } from './Un1tPaymentsCard'
import { formatMoney, relativeTime } from './format'

const KIND_LABEL = { member: 'Member', client: 'Client', lead: 'Lead' }

function Row({ label, value }) {
  if (value == null || value === '') return null
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-un1t-subtle">{label}</span>
      <span className="font-medium text-un1t-text text-right">{value}</span>
    </div>
  )
}

export default function StudioMembershipCard({ membership: m, contact = null, glofoxMode, un1tStudio = null }) {
  if (!m) return null
  if (m.platform === 'glofox') return <GlofoxProfileCard contact={contact} mode={glofoxMode} />

  const heading = (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Membership · {m.name}</h3>
      {m.platform === 'un1t_online' && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-700">un1t.online</span>
      )}
    </div>
  )

  if (m.platform !== 'un1t_online') {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-2">
        {heading}
        <p className="text-sm text-un1t-text">{KIND_LABEL[m.kind] || m.kind || 'Contact'} · {m.status === 'active' ? 'Active' : 'Ended'}</p>
        <p className="text-xs text-un1t-subtle">No membership system at this studio.</p>
      </div>
    )
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
      {heading}
      <div className="space-y-1.5">
        <Row label="Status" value={`${KIND_LABEL[m.kind] || m.kind || 'Client'} · ${m.status === 'active' ? 'Active' : 'Ended'}`} />
        <Row label="Plan" value={m.plan} />
        <Row label="Credits" value={m.creditsLine} />
        <Row label="Attended 30d" value={m.attended30d} />
        <Row label="Last class" value={m.lastAttendedAt ? relativeTime(m.lastAttendedAt) : null} />
        <Row label="Lifetime value" value={m.ltvCents != null ? formatMoney(m.ltvCents, 'EUR') : null} />
        <Row label="Synced" value={m.syncedAt ? relativeTime(m.syncedAt) : null} />
      </div>
      {un1tStudio && (
        <div className="pt-2 border-t border-un1t-border">
          <StudioBlock studio={{ ...un1tStudio, locationName: 'Payments' }} />
        </div>
      )}
    </div>
  )
}
