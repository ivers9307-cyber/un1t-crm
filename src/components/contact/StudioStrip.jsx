// CARDLENS.8 — the studios strip under the contact header, for a person with
// a relationship at two or more studios. One tile per studio
// (studioMemberships(), src/lib/contact-studio-memberships.js): its platform,
// kind and status, what it says is owed, plan, attendance, last class and last
// sync. A tile is a ?studio= link where the viewer can act there
// (actingStudioOptions); "All studios" shows everything and acts nowhere.
// Server component, no state. Replaces CARDLENS.6's ActingStudioBar.
import Link from 'next/link'
import { formatMoney, relativeTime } from './format'

const PLATFORM = {
  glofox: { label: 'Glofox', cls: 'bg-orange-500/10 text-orange-700' },
  un1t_online: { label: 'un1t.online', cls: 'bg-blue-500/10 text-blue-700' },
  none: { label: 'CRM only', cls: 'bg-slate-500/10 text-slate-700' },
}
const KIND_LABEL = { member: 'Member', client: 'Client', lead: 'Lead' }
const CHIP = 'text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap'

export function owedLabel(m) {
  if (m.overdue) {
    const amount = m.owedCents > 0 ? formatMoney(m.owedCents, 'EUR') : null
    return { text: amount ? `${amount} overdue` : 'Overdue · amount not reported', cls: 'bg-red-500/10 text-red-700' }
  }
  if (m.owedCents === 0) return { text: 'Nothing owed', cls: 'bg-slate-500/10 text-slate-700' }
  return null
}

function Fact({ label, value }) {
  return (
    <>
      <dt className="text-un1t-subtle">{label}</dt>
      <dd className="font-medium text-un1t-text truncate">{value ?? '—'}</dd>
    </>
  )
}

function Tile({ m }) {
  const p = PLATFORM[m.platform] || PLATFORM.none
  const owed = owedLabel(m)
  return (
    <>
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-sm font-semibold text-un1t-text truncate">{m.name}</span>
        <span className="flex shrink-0 items-center gap-1">
          {m.primary && <span className={`${CHIP} bg-slate-500/10 text-slate-700`}>Primary</span>}
          <span className={`${CHIP} ${p.cls}`}>{p.label}</span>
        </span>
      </span>
      <span className="flex flex-wrap gap-1">
        <span className={`${CHIP} ${m.status === 'active' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-gray-500/10 text-gray-700'}`}>
          {KIND_LABEL[m.kind] || m.kind || 'Studio'} · {m.status === 'active' ? 'Active' : 'Ended'}
        </span>
        {owed && <span className={`${CHIP} ${owed.cls}`}>{owed.text}</span>}
      </span>
      <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        <Fact label="Plan" value={m.plan} />
        {m.creditsLine && <Fact label="Credits" value={m.creditsLine} />}
        <Fact label="Attended 30d" value={m.attended30d} />
        <Fact label="Last class" value={m.lastAttendedAt ? relativeTime(m.lastAttendedAt) : null} />
        {m.syncedAt && <Fact label="Synced" value={relativeTime(m.syncedAt)} />}
      </dl>
    </>
  )
}

const TILE = 'flex flex-col items-start gap-2 rounded-lg bg-un1t-surface p-3 text-left'

// CARDLENS.11 — a studio link keeps the rest of the page's query (the first
// value of a repeated key), replacing only `studio`.
export function studioHref(query, studio) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query || {})) {
    if (k === 'studio') continue
    const first = Array.isArray(v) ? v[0] : v
    if (typeof first === 'string') params.set(k, first)
  }
  params.set('studio', studio)
  return `?${params.toString()}`
}

export default function StudioStrip({ memberships = [], options = [], actingId = null, lensAll = false, query = null }) {
  if (!Array.isArray(memberships) || memberships.length < 2) return null
  const actable = new Set((options || []).map((o) => o.locationId))
  const acting = lensAll ? null : (options || []).find((o) => o.locationId === actingId) || null
  const actingMembership = acting ? memberships.find((x) => x.locationId === acting.locationId) : null
  const bookings = acting ? (PLATFORM[actingMembership?.platform || acting.source]?.label || 'the CRM') : null
  const pill = (on) => `text-xs font-medium px-3 py-1.5 rounded-md border ${on
    ? 'bg-un1t-text text-un1t-bg border-un1t-text'
    : 'bg-un1t-surface text-un1t-text border-un1t-border hover:bg-un1t-bg'}`
  return (
    <section aria-label="Studios" className="mb-5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Studios</h2>
        <Link href={studioHref(query, 'all')} aria-current={lensAll ? 'true' : undefined} className={pill(lensAll)}>All studios</Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {memberships.map((m) => {
          const on = !lensAll && m.locationId === actingId
          const border = on ? 'border-2 border-un1t-text' : 'border border-un1t-border'
          return actable.has(m.locationId) ? (
            <Link key={m.locationId} href={studioHref(query, m.locationId)} aria-current={on ? 'true' : undefined} className={`${TILE} ${border} hover:bg-un1t-bg`}>
              <Tile m={m} />
            </Link>
          ) : (
            <div key={m.locationId} className={`${TILE} ${border}`}>
              <Tile m={m} />
            </div>
          )
        })}
      </div>
      <p className="text-xs text-un1t-subtle">
        {lensAll
          ? 'Viewing all studios. Pick a studio to message, book or add a note.'
          : acting
            ? <><span className="font-semibold text-un1t-text">Acting at {acting.name}.</span> Messages, notes and tasks are for {acting.name}; bookings go through {bookings}.</>
            : null}
      </p>
    </section>
  )
}
