// GAPS-P5 — list health.
//
// The one place that answers "how many people can this studio actually email,
// and what happened to everyone else". Until now those numbers only existed
// inside the pre-send count on a single campaign, so a list quietly rotting
// between sends was invisible.
//
// Every count here comes from the SAME query path a send uses:
// contact_location_audience (mig 491) for the population, and
// buildAudienceQueryAsync for the mailable number, which is the exact builder
// campaign-sender calls. A list-health page that disagrees with the send is
// worse than no page.
//
// The suppression tables below are the audit trail for GAPS-P5's repeat-bounce
// escalation (mig 515), and each row can be undone from here.
//
// GAPS-P7 adds the SLOPE. Everything above was a snapshot, and a snapshot
// cannot show that the list lost 110 people net over four months while every
// number on the page looked fine. list_health_monthly_stats (mig 517)
// aggregates that in Postgres for the same reason as the bounce summary: June
// alone carries 9,739 recipient rows, and counting them in this page would
// return the first 1,000 and report a confident, wrong number.
//
// The consent side is CATEGORISED, not summed: 5,521 of the 5,749 opt-out rows
// since May are one-off migrations, 5,519 of them from a single day. The
// mapping lives in consent-sources.js and is passed to the RPC on every call.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { buildAudienceQueryAsync } from '@/lib/postmark'
import { ESCALATION_TABLE } from '@/lib/bounce-escalation-sweep'
import { BOUNCE_ESCALATION_MIN_CAMPAIGNS } from '@/lib/bounce-escalation'
import ListHealthEscalations from '@/components/communications/ListHealthEscalations'
import ListHealthTrend from '@/components/communications/ListHealthTrend'
import OtherEmailDeliverability from '@/components/communications/OtherEmailDeliverability'
import { buildListHealthTrend } from '@/lib/list-health-trend'
import { buildEmailSourceTrend } from '@/lib/email-source-trend'
import { consentSourceRpcArgs } from '@/lib/consent-sources'

export const dynamic = 'force-dynamic'

// Twelve months of history. Long enough to see a season, short enough that the
// table stays readable in one glance.
const TREND_MONTHS = 12

// Bounded: the tables are a working list, not an export. If a location ever
// carries more than this, the counts above still tell the true story.
const MAX_ROWS = 200

const EMPTY_FILTER = { logic: 'and', filters: [] }

function Stat({ label, value, hint }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
      <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-2">{label}</div>
      <div className="text-2xl font-bold text-un1t-text">{value}</div>
      {hint && <div className="text-xs text-un1t-subtle mt-1">{hint}</div>}
    </div>
  )
}

function dateLabel(iso) {
  if (!iso) return 'Not recorded'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Not recorded'
  return d.toLocaleDateString('en-IE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Dublin' })
}

function toRow(row) {
  return {
    id: row.id,
    name: row.contact?.name || null,
    email: row.contact?.email || null,
    bounced_campaign_count: row.bounced_campaign_count ?? 0,
    bounce_events: row.bounce_events ?? 0,
    bounce_types_label: (row.bounce_types || []).join(', ') || 'unknown',
    successful_deliveries: row.successful_deliveries ?? 0,
    last_bounce_label: dateLabel(row.last_bounce_at),
    since_label: dateLabel(row.suppressed_at || row.created_at),
  }
}

export default async function ListHealthPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'email')) redirect('/communications')

  const locationId = user.activeLocation?.id
  if (!locationId) {
    return <p className="text-sm text-un1t-subtle">Pick a location to see its list health.</p>
  }

  const db = createServerClient()

  // Single-table counts over the per-location audience view. head:true returns
  // the true count and is safe here precisely because there is no embedded
  // resource in the query (CLASSIFY.1).
  const viewCount = async (refine) => {
    let q = db
      .from('contact_location_audience')
      .select('id', { count: 'exact', head: true })
      .eq('audience_location_id', locationId)
    if (refine) q = refine(q)
    const { count } = await q
    return count || 0
  }

  const onList = await viewCount(null)
  const notOptedIn = await viewCount((q) => q.eq('loc_email_marketing', false))
  const bouncedOrComplained = await viewCount((q) => q.in('email_status', ['bounced', 'complained']))
  const suppressed = await viewCount((q) => q.eq('loc_email_marketing', true).not('email_suppressed_at', 'is', null))

  // The mailable number comes from the SEND builder itself, not a hand-copy of
  // its gates, so it cannot drift away from what a campaign would reach.
  const { query: eligibleQuery } = await buildAudienceQueryAsync(db, EMPTY_FILTER, locationId, {
    columns: 'id',
    selectOpts: { count: 'exact', head: true },
  })
  const { count: mailableCount } = await eligibleQuery
  const mailable = mailableCount || 0

  // Bounce events by type for this location. campaign_recipients carries no
  // location_id, so the join to campaigns happens in Postgres (mig 515) rather
  // than through a PostgREST embed, which would break the count.
  const { data: bounceSummary } = await db.rpc('email_bounce_type_summary', { p_location_id: locationId })

  // GAPS-P7 — the monthly slope. Same shape of call and the same tenant
  // boundary: the RPC takes a bare location uuid and does no access check of
  // its own, so locationId must be the active location this page already
  // resolved from the session, never a value off the request.
  //
  // The consent-source categories travel WITH the call. The RPC holds no copy
  // of the vocabulary, so consent-sources.js is the only place a source is
  // classified; omitting these arrays would land every consent row in the
  // unclassified bucket, which the surface shows rather than swallows.
  const { data: trendRows, error: trendError } = await db.rpc('list_health_monthly_stats', {
    p_location_id: locationId,
    p_months: TREND_MONTHS,
    ...consentSourceRpcArgs(),
  })
  if (trendError) console.error('[list health] list_health_monthly_stats failed:', trendError.message)
  const trend = buildListHealthTrend(trendRows)

  // REPORT-SOT.1 — the other half of the sending domain. The table above reads
  // campaign_recipients and therefore covers CAMPAIGNS ONLY; sequence,
  // transactional and inbox-reply mail lives in email_sends and had no
  // deliverability view anywhere in the product. Same tenant boundary as the
  // call above: the RPC takes a bare location uuid and does no access check of
  // its own, so locationId must stay the active location resolved from the
  // session. Aggregated in Postgres (mig 521) because email_sends carries
  // 19,207 rows and the 1,000-row select cap would under-report it silently.
  const { data: sourceRows, error: sourceError } = await db.rpc('email_sends_monthly_stats', {
    p_location_id: locationId,
    p_months: TREND_MONTHS,
  })
  if (sourceError) console.error('[list health] email_sends_monthly_stats failed:', sourceError.message)
  const sourceTrend = buildEmailSourceTrend(sourceRows)

  const escalationCount = async (decision) => {
    const { count } = await db
      .from(ESCALATION_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('decision', decision)
      .is('released_at', null)
    return count || 0
  }
  const suppressedForBounces = await escalationCount('suppress')
  const awaitingReview = await escalationCount('review')

  const escalationRows = async (decision) => {
    const { data } = await db
      .from(ESCALATION_TABLE)
      .select('id, decision, bounced_campaign_count, bounce_events, bounce_types, successful_deliveries, last_bounce_at, suppressed_at, created_at, contact:contacts!contact_id ( id, name, email )')
      .eq('location_id', locationId)
      .eq('decision', decision)
      .is('released_at', null)
      .order('created_at', { ascending: false })
      .range(0, MAX_ROWS - 1)
    return (data || []).map(toRow)
  }
  const suppressedRows = await escalationRows('suppress')
  const reviewRows = await escalationRows('review')

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-un1t-text">List health</h2>
        <p className="text-sm text-un1t-subtle mt-1 max-w-3xl">
          Who this studio can email today, how the list has moved month by month, and what happened to
          everyone else. Sending to addresses that
          keep failing is what damages the sending domain, so contacts are removed when nothing has ever
          reached them.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
        <Stat label="On this list" value={onList.toLocaleString()} hint="Contacts with a record at this studio" />
        <Stat label="Can be emailed now" value={mailable.toLocaleString()} hint="What a marketing send would reach" />
        <Stat label="Not opted in" value={notOptedIn.toLocaleString()} hint="No marketing consent here" />
        <Stat label="Bounced or complained" value={bouncedOrComplained.toLocaleString()} hint="Hard bounce or spam report" />
        <Stat label="Suppressed" value={suppressed.toLocaleString()} hint="Opted in, but held back for list hygiene" />
      </div>

      <ListHealthTrend trend={trend} />

      <div className="mb-8">
        <OtherEmailDeliverability trend={sourceTrend} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-un1t-text mb-1">Bounces by type</h3>
          <p className="text-xs text-un1t-subtle mb-3">
            All campaign bounces recorded at this studio. Hard bounces are permanent and are removed on the
            spot. Rejected means the provider refused the address at send time. Soft and transient bounces
            are temporary and are not acted on individually.
          </p>
          {(bounceSummary || []).length === 0 ? (
            <p className="text-sm text-un1t-subtle py-4">No bounces recorded.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-un1t-border text-left text-xs uppercase tracking-wide text-un1t-muted">
                  <th className="py-2 px-3 font-medium">Type</th>
                  <th className="py-2 px-3 font-medium text-right">Events</th>
                  <th className="py-2 px-3 font-medium text-right">Contacts</th>
                </tr>
              </thead>
              <tbody>
                {(bounceSummary || []).map((r) => (
                  <tr key={r.bounce_type} className="border-b border-un1t-border/50">
                    <td className="py-2 px-3 text-un1t-text capitalize">{r.bounce_type}</td>
                    <td className="py-2 px-3 text-right text-un1t-text">{Number(r.events).toLocaleString()}</td>
                    <td className="py-2 px-3 text-right text-un1t-text">{Number(r.contacts).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-un1t-text mb-1">Repeat bounces</h3>
          <p className="text-xs text-un1t-subtle mb-3">
            A contact is suppressed only after bouncing in {BOUNCE_ESCALATION_MIN_CAMPAIGNS} or more separate
            campaigns with no successful delivery on record. Repeat bouncers that have been delivered to at
            some point are listed for review and are never acted on automatically.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-un1t-border p-4">
              <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">Suppressed</div>
              <div className="text-2xl font-bold text-un1t-text">{suppressedForBounces.toLocaleString()}</div>
            </div>
            <div className="rounded-xl border border-un1t-border p-4">
              <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">Awaiting review</div>
              <div className="text-2xl font-bold text-un1t-text">{awaitingReview.toLocaleString()}</div>
            </div>
          </div>
          <p className="text-xs text-un1t-subtle mt-3">
            Suppression is reversible. Restoring a contact puts them back in the audience and stops the
            nightly check from suppressing them for bounces again.
          </p>
        </div>
      </div>

      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-6">
        <h3 className="text-sm font-semibold text-un1t-text mb-1">Suppressed for repeat bounces</h3>
        <p className="text-xs text-un1t-subtle mb-3">
          Nothing has ever reached these addresses. Marketing email skips them; booking confirmations and
          other transactional mail still go out as normal.
        </p>
        <ListHealthEscalations rows={suppressedRows} mode="suppress" />
        {suppressedForBounces > MAX_ROWS && (
          <p className="text-xs text-un1t-subtle mt-3">
            Showing the {MAX_ROWS} most recent of {suppressedForBounces.toLocaleString()}.
          </p>
        )}
      </div>

      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-un1t-text mb-1">Repeat bounces to review</h3>
        <p className="text-xs text-un1t-subtle mb-3">
          These addresses have accepted mail before, so the bounces may be a full mailbox or a temporary
          server problem. They are still being emailed, and nothing here happens automatically. Dismiss a
          row if the address looks fine, or Suppress it to stop marketing email to that address and record
          why. A suppression made here appears in the table above and can be undone from there.
        </p>
        <ListHealthEscalations rows={reviewRows} mode="review" />
        {awaitingReview > MAX_ROWS && (
          <p className="text-xs text-un1t-subtle mt-3">
            Showing the {MAX_ROWS} most recent of {awaitingReview.toLocaleString()}.
          </p>
        )}
      </div>

      <p className="text-xs text-un1t-subtle mt-6">
        Consent and preferences for an individual contact live on their{' '}
        <Link href="/contacts" className="underline hover:text-un1t-text">contact record</Link>.
      </p>
    </div>
  )
}
