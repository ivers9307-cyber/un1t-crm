// ZOOMOPS.1 — the operator's detail page for the Zoom Phone contact sync.
//
// Server component. Pulls together three already-built pieces so nothing here
// re-derives sync behaviour:
//   - listRuns() / zoomSyncStatus()  (src/lib/zoom/sync-runs, src/lib/integration-health)
//   - buildDesiredContacts(db, { collectRejects: true })  (src/lib/zoom/desired-contacts)
//     — the SAME code path the nightly sync uses, so the rejected-contacts
//     report cannot say something different from what the sync actually does.
// Write controls live in the client-side <Controls>, gated on the identical
// permission the API route checks.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentUser, assertOrganizationAccess } from '@/lib/auth'
import { hasPermissionInOrganization } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { listRuns } from '@/lib/zoom/sync-runs'
import { zoomSyncStatus } from '@/lib/integration-health'
import { buildDesiredContacts } from '@/lib/zoom/desired-contacts'
import { E164_REJECTION_LABELS } from '@/lib/zoom/publishable-e164'
import { Card, Table, EmptyState } from '@/components/ui'
import Controls from './Controls.jsx'

export const dynamic = 'force-dynamic'

// Light-theme status chips (un1t-* palette — text on the -700 ramp per
// check:guardrails' no-low-contrast-chip rule). Matches /settings/integration-health.
const STATUS = {
  ok: { label: 'Healthy', chip: 'bg-green-500/10 text-green-700' },
  warn: { label: 'Degraded', chip: 'bg-amber-500/10 text-amber-700' },
  down: { label: 'Down', chip: 'bg-red-500/10 text-red-700' },
  unknown: { label: 'Unknown', chip: 'bg-slate-500/10 text-slate-700' },
}

// invalid_e164 first: it is the newest and the most actionable group (~12 rows,
// ZOOMSYNC.4) — every one of them is a real member whose number is wrong in the
// CRM and who therefore has no name on the handsets. unparseable (~89) follows;
// no_phone (~219) and no_name come last so they don't bury either.
const REASON_ORDER = ['invalid_e164', 'unparseable', 'no_phone', 'no_name']
const REASON_LABEL = {
  invalid_e164: 'Phone number Zoom will not accept',
  unparseable: 'Unparseable phone number',
  no_phone: 'No phone number',
  no_name: 'No usable name',
}
const REPORT_CAP = 100

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
}

export default async function ZoomContactsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const syncOrgId = process.env.ZOOM_SYNC_ORGANIZATION_ID || null

  // Mirrors POST /api/integrations/zoom-contacts/run's own gate exactly (see
  // that route's comment on assertOrganizationAccess vs activeOrganization).
  // Membership is a fact about the caller's location/org-admin ASSIGNMENTS,
  // never `activeOrganization` — that only mirrors whichever location happens
  // to be selected right now. Reading the active org here would reintroduce
  // the bug the route was already fixed for: a genuine member of the synced
  // org, with a different location selected, told this isn't their org. An
  // unset syncOrgId fails closed for non-master, same as the route — the sync
  // ships dark until the ZOOM_* secrets land.
  const orgForbidden = !user.isMaster && (!syncOrgId || Boolean(assertOrganizationAccess(user, syncOrgId)))

  if (orgForbidden) {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-2xl font-bold text-un1t-text mb-6">Zoom phone directory</h1>
        <EmptyState
          title="Not configured for this organisation"
          description="The Zoom Phone contact sync is scoped to one organisation. There is nothing to show for the organisation you're currently in."
        />
      </div>
    )
  }

  const canManage = user.isMaster || hasPermissionInOrganization(user, syncOrgId, 'integrations_zoom_manage')

  const db = createServerClient()
  const [runs, reportRes] = await Promise.all([
    syncOrgId ? listRuns(db, syncOrgId) : Promise.resolve([]),
    buildDesiredContacts(db, { collectRejects: true }),
  ])

  // Actor names for "who ran this" — a small second query rather than
  // widening listRuns()'s select('*') (that file is out of scope for this task).
  const actorIds = [...new Set(runs.map((r) => r.triggered_by).filter(Boolean))]
  let namesById = {}
  if (actorIds.length > 0) {
    const { data: profs } = await db.from('profiles').select('id, full_name').in('id', actorIds)
    namesById = Object.fromEntries((profs || []).map((p) => [p.id, p.full_name]))
  }

  // The health pane's own rule: a preview is not a run, so status is read off
  // the newest run that actually wrote to Zoom.
  const lastRealRun = runs.find((r) => !r.dry) || null
  const status = zoomSyncStatus(lastRealRun)
  const s = STATUS[status.status] || STATUS.unknown

  // The guard-override control reads "the last run's guard_sample" verbatim
  // (spec: "approving a list you can read is [consent]") — the newest run of
  // either kind, since a preview computes the same guard a real run would.
  const newestRun = runs[0] || null
  const initialGuard = newestRun?.guard_tripped
    ? {
        tripped: true,
        sample: Array.isArray(newestRun.guard_sample) ? newestRun.guard_sample : [],
        threshold: newestRun.guard_threshold,
        attempted: newestRun.guard_attempted,
      }
    : null

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-un1t-text">Zoom phone directory</h1>
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${s.chip}`}>{s.label}</span>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">{status.detail}</p>

      <Card title="Controls" className="mb-6">
        <Controls canManage={canManage} initialGuard={initialGuard} />
      </Card>

      <Card title="Run history" className="mb-6">
        <Table
          columns={[
            { key: 'started', header: 'Started', render: (r) => fmtDate(r.started_at) },
            {
              key: 'trigger',
              header: 'Trigger',
              render: (r) => (
                <span className="inline-flex items-center gap-2">
                  {r.trigger === 'manual' ? (namesById[r.triggered_by] || 'Manual') : 'Cron'}
                  {r.dry ? (
                    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-700">Preview</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'counts',
              header: 'Counts',
              render: (r) => (Number.isFinite(r.creates) ? `+${r.creates} ~${r.updates} -${r.deletes}` : '—'),
            },
            { key: 'enqueued', header: 'Enqueued', render: (r) => (r.enqueued ?? '—') },
            {
              key: 'guard',
              header: 'Guard',
              render: (r) => (r.guard_tripped ? (
                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-red-500/10 text-red-700">Guard tripped</span>
              ) : '—'),
            },
          ]}
          rows={runs}
          rowKey={(r) => r.id}
          empty="No runs recorded yet."
        />
      </Card>

      <Card title="Contacts the sync cannot use">
        {!reportRes.ok ? (
          <p className="text-sm text-red-700">{reportRes.error}</p>
        ) : (
          <div className="flex flex-col gap-6">
            {reportRes.rejects.length === 0 ? (
              <p className="text-sm text-un1t-subtle">Nothing rejected — every scanned contact has a usable name and phone number.</p>
            ) : null}
            {REASON_ORDER.map((reason) => {
              const group = reportRes.rejects.filter((r) => r.reason === reason)
              if (group.length === 0) return null
              const shown = group.slice(0, REPORT_CAP)
              return (
                <div key={reason}>
                  <h4 className="text-sm font-semibold text-un1t-text mb-2">
                    {REASON_LABEL[reason]} <span className="text-un1t-subtle font-normal">({group.length})</span>
                  </h4>
                  <Table
                    columns={[
                      {
                        key: 'name',
                        header: 'Contact',
                        render: (row) => (
                          <Link href={`/contacts/${row.id}`} className="text-mia hover:underline">
                            {row.name || '(no name)'}
                          </Link>
                        ),
                      },
                      { key: 'phone', header: 'Stored phone', render: (row) => row.phone || '—' },
                      // Only invalid_e164 rows carry a detail, and "what is
                      // wrong with it" is the difference between a fixable row
                      // and a shrug — the other groups say it in their heading.
                      ...(reason === 'invalid_e164' ? [{
                        key: 'detail',
                        header: 'Problem',
                        render: (row) => E164_REJECTION_LABELS[row.detail] || '—',
                      }] : []),
                    ]}
                    rows={shown}
                    rowKey={(row) => row.id}
                  />
                  {group.length > REPORT_CAP ? (
                    <p className="text-xs text-un1t-muted mt-1">Showing {REPORT_CAP} of {group.length}.</p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
