// SAAS4-M3 — /settings/usage: org-level month-to-date usage + the two
// optional hard caps (SaaS machinery plan §3; decisions settled
// 2026-07-19: allowance = soft band via the plans/wallets track; only
// these operator-set hard caps interrupt service).
//
// Data: live cap-relevant numbers (AI spend, email sends — mig 421
// RPCs) + nightly rollup totals per meter and per location. The
// rollup rows refresh at 02:40 UTC, so the per-location split can lag
// a day; the cap numbers are always live.
//
// Auth: ADMIN_ROLES view (usage is an operations number); the caps
// form itself is owner/master (an ownership decision) — the client
// component hides the save affordance otherwise, and the PUT route
// enforces it server-side regardless.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { ADMIN_ROLES } from '@/lib/schemas'
import { getOrgUsageSummary } from '@/lib/usage-summary'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Gauge } from 'lucide-react'
import UsageCapsForm from '@/components/settings/UsageCapsForm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const METER_LABELS = {
  anthropic_tokens: 'AI tokens (Mia + assistant)',
  email_send: 'Emails sent',
  sms_send: 'SMS sent',
  wa_template_send: 'WhatsApp templates',
}

function fmtQty(meter, m) {
  if (!m) return '—'
  return Number(m.quantity).toLocaleString()
}

export default async function UsageSettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!ADMIN_ROLES.includes(user.role) || !hasPermission(user, 'settings')) redirect('/settings')

  const orgId = user.activeOrganization?.id
  if (!orgId) redirect('/settings')

  const db = createServerClient()
  const summary = await getOrgUsageSummary(db, orgId)
  const canEditCaps = user.role === 'owner' || user.role === 'master'

  const aiCap = summary.caps.ai_hard_cap_cents
  const emailCap = summary.caps.email_hard_cap_sends

  return (
    <div className="p-6 max-w-4xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ArrowLeft size={14} /> Settings
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <Gauge size={20} className="text-un1t-subtle" />
        <h1 className="text-2xl font-semibold">Usage &amp; caps</h1>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        {user.activeOrganization?.name} · month starting {summary.month_start}. Cap numbers are live;
        the per-location split refreshes nightly.
      </p>

      {/* Live cap-relevant headline numbers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <div className="text-xs text-un1t-subtle uppercase tracking-wide mb-1">AI spend (billable, est.)</div>
          <div className="text-2xl font-semibold tabular-nums">
            ${(summary.live.ai_spend_cents / 100).toFixed(2)}
            {aiCap != null && (
              <span className="text-sm font-normal text-un1t-subtle"> / ${(aiCap / 100).toFixed(2)} cap</span>
            )}
          </div>
          <div className="text-xs text-un1t-subtle mt-1">
            Customer-facing Mia only — the staff assistant is metered but not counted. At the cap, Mia
            pauses with a human handoff.
          </div>
        </div>
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <div className="text-xs text-un1t-subtle uppercase tracking-wide mb-1">Emails sent</div>
          <div className="text-2xl font-semibold tabular-nums">
            {summary.live.email_sends.toLocaleString()}
            {emailCap != null && (
              <span className="text-sm font-normal text-un1t-subtle"> / {emailCap.toLocaleString()} cap</span>
            )}
          </div>
          <div className="text-xs text-un1t-subtle mt-1">
            All sent email. At the cap, new campaigns are refused; sequences and reminders keep working.
          </div>
        </div>
      </div>

      {/* Month-to-date meters (nightly rollups) */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 mb-6">
        <div className="text-sm font-medium mb-3">Month to date, all meters</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Object.entries(METER_LABELS).map(([meter, label]) => (
            <div key={meter}>
              <div className="text-xs text-un1t-subtle">{label}</div>
              <div className="text-lg font-semibold tabular-nums">{fmtQty(meter, summary.meters[meter])}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-location split */}
      {Object.keys(summary.by_location).length > 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 mb-6 overflow-x-auto">
          <div className="text-sm font-medium mb-3">By location</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-un1t-subtle uppercase tracking-wide">
                <th className="py-1.5 pr-4">Location</th>
                {Object.values(METER_LABELS).map((label) => (
                  <th key={label} className="py-1.5 pr-4">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.by_location).map(([id, loc]) => (
                <tr key={id} className="border-t border-un1t-border">
                  <td className="py-2 pr-4">{loc.name}</td>
                  {Object.keys(METER_LABELS).map((meter) => (
                    <td key={meter} className="py-2 pr-4 tabular-nums">{fmtQty(meter, loc.meters[meter])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Hard caps */}
      <UsageCapsForm
        organizationId={orgId}
        canEdit={canEditCaps}
        initialAiCapCents={aiCap}
        initialEmailCapSends={emailCap}
        initialOpsEmails={summary.caps.ops_alert_emails}
      />
    </div>
  )
}
