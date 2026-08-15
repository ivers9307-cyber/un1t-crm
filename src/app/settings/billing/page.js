// INTEG-D1 — /settings/billing: the tenant-side "Billing & usage"
// page (Integrations & Monetisation plan, approved mockup IA).
//
// PINNING-GATED: an org with zero active tier pinnings (every real
// org today — UN1T Group, CCF Autos) sees ONE quiet empty state and
// nothing else; the whole surface is inert until the master pins a
// plan. Per pinned location: plan block, month-to-date meters vs
// allowance (staff assistant shown separately — allowance-exempt),
// wallet (balance + Dublin month-end expiry + late-month lapse
// warning + last-20 ledger + auto-top-up config), then org-level
// invoices (empty state v1) and billing contact (disabled — no
// columns yet).
//
// Auth mirrors the SAAS4-M3 /settings/usage page shape (redirect
// pattern + hasPermission('settings')), narrowed to owner/master —
// billing is an ownership surface end to end, so unlike usage there
// is no manager read tier. Same permissions decision as M3: NO new
// WEB_PERMISSIONS key — billing rides the existing `settings` key,
// which already has a mobile counterpart (staff_management
// webEquivalent), and the WEB_ONLY_OK notes already record that
// billing-class sub-features of `settings` stay web-only.
//
// INTEG-C2b lights up the wallet card (fixed-denomination Stripe
// top-up buttons) and the invoices section (TU top-up invoices, last
// 24) — both still pinning-gated, so nothing changes for real orgs
// today. ?topup=success|cancelled is Stripe Checkout's return leg
// (informational banner only — the wallet credit itself lands via the
// /api/webhooks/stripe-wallet fulfilment, never the redirect).

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { getBillingPageData } from '@/lib/billing-page'
import { METERS } from '@shared/plans'
import { redirect } from 'next/navigation'
import { CreditCard, ReceiptText, Wallet } from 'lucide-react'
import AutoTopupForm from '@/components/settings/AutoTopupForm'
import WalletTopupButtons from '@/components/settings/WalletTopupButtons'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function euro(cents) {
  return `€${((Number(cents) || 0) / 100).toFixed(2)}`
}

// Human date for a YYYY-MM-DD calendar string — noon-UTC anchor so the
// label can never slip a day in any rendering timezone.
function dateLabel(dateStr) {
  if (!dateStr) return '—'
  return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${dateStr}T12:00:00Z`))
}

function dateTimeLabel(iso) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'short', timeZone: 'Europe/Dublin',
  }).format(new Date(iso))
}

const LEDGER_KIND_CHIPS = {
  topup: { label: 'Top-up', className: 'bg-green-500/10 text-green-700' },
  draw: { label: 'Draw', className: 'bg-red-500/10 text-red-700' },
  adjustment: { label: 'Adjustment', className: 'bg-amber-500/10 text-amber-700' },
  expiry_reset: { label: 'Expiry', className: 'bg-un1t-border text-un1t-subtle' },
}

function KindChip({ kind }) {
  const chip = LEDGER_KIND_CHIPS[kind] || { label: kind, className: 'bg-un1t-border text-un1t-subtle' }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${chip.className}`}>
      {chip.label}
    </span>
  )
}

// TU invoice lifecycle chips (INTEG-C2b) — light-theme recipe
// (bg-*-500/10 + -700 text) per the guardrails lint.
const INVOICE_STATUS_CHIPS = {
  pending: { label: 'Pending', className: 'bg-amber-500/10 text-amber-700' },
  paid: { label: 'Paid', className: 'bg-green-500/10 text-green-700' },
  expired: { label: 'Expired', className: 'bg-un1t-border text-un1t-subtle' },
  failed: { label: 'Failed', className: 'bg-red-500/10 text-red-700' },
}

function InvoiceStatusChip({ status }) {
  const chip = INVOICE_STATUS_CHIPS[status] || { label: status, className: 'bg-un1t-border text-un1t-subtle' }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${chip.className}`}>
      {chip.label}
    </span>
  )
}

export default async function BillingSettingsPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Owner/master only — billing is an ownership surface (narrower than
  // /settings/usage, which grants managers a read tier).
  if (user.role !== 'owner' && user.role !== 'master') redirect('/settings')
  if (!hasPermission(user, 'settings')) redirect('/settings')

  const orgId = user.activeOrganization?.id
  if (!orgId) redirect('/settings')

  // Stripe Checkout return leg (?topup=success|cancelled) — banner
  // only; the wallet credit lands via the webhook, so "success" is
  // worded as received-not-necessarily-credited-yet.
  const params = await searchParams
  const topupReturn = params?.topup === 'success' || params?.topup === 'cancelled' ? params.topup : null

  const db = createServerClient()
  const data = await getBillingPageData(db, orgId)

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center gap-2 mb-1">
        <CreditCard size={20} className="text-un1t-subtle" />
        <h1 className="text-2xl font-semibold">Billing &amp; usage</h1>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        {user.activeOrganization?.name} · month starting {dateLabel(data.month_start)}
      </p>

      {topupReturn === 'success' && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-sm rounded-lg p-3 mb-6">
          Payment received. The wallet credit and your VAT invoice email land as soon as Stripe
          confirms the payment (usually within a minute) — refresh to see the new balance.
        </div>
      )}
      {topupReturn === 'cancelled' && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-sm rounded-lg p-3 mb-6">
          Top-up cancelled — nothing was charged.
        </div>
      )}

      {!data.pinned ? (
        // The quiet truth for every org today: nothing pinned, nothing billed.
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6 text-sm text-un1t-subtle">
          No platform plan — billing isn&apos;t active for this organisation.
        </div>
      ) : (
        <>
          {data.locations.map((loc) => (
            <div key={loc.location_id} className="mb-10">
              <h2 className="text-lg font-semibold mb-3">{loc.location_name}</h2>

              {/* Plan */}
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 mb-3">
                <div className="flex items-baseline justify-between flex-wrap gap-2">
                  <div>
                    <div className="text-xs text-un1t-subtle uppercase tracking-wide mb-1">Plan</div>
                    <div className="text-xl font-semibold">
                      {loc.plan.tier_name}
                      <span className="text-sm font-normal text-un1t-subtle"> · {euro(loc.plan.price_cents)}/month</span>
                    </div>
                  </div>
                  <div className="text-xs text-un1t-subtle">since {dateLabel(loc.plan.effective_from)}</div>
                </div>
                {loc.plan.addons.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {loc.plan.addons.map((addon) => (
                      <span key={addon.slug} className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full">
                        {addon.name} · {euro(addon.price_cents)}/mo
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Meters — month to date vs allowance */}
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 mb-3">
                <div className="text-sm font-medium mb-3">Usage this month</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {Object.entries(METERS).map(([key, meta]) => {
                    const m = loc.meters[key] || { used: 0, allowance: 0, over: 0 }
                    return (
                      <div key={key}>
                        <div className="text-xs text-un1t-subtle">{meta.label}</div>
                        <div className="text-lg font-semibold tabular-nums">
                          {m.used.toLocaleString()}
                          <span className="text-sm font-normal text-un1t-subtle"> / {m.allowance.toLocaleString()}</span>
                          {m.over > 0 && (
                            <span className="text-sm font-medium text-red-700"> +{m.over.toLocaleString()} over</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-un1t-subtle mt-3">
                  Staff assistant: {loc.assistant_exempt_messages.toLocaleString()} messages this month —
                  metered, never counted against the allowance. WhatsApp and email totals refresh nightly;
                  AI messages are live.
                </p>
              </div>

              {/* Wallet */}
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <Wallet size={16} className="text-un1t-subtle" />
                    <span className="text-sm font-medium">Usage wallet</span>
                  </div>
                  <div className="text-xl font-semibold tabular-nums">{euro(loc.wallet.balance_cents)}</div>
                </div>
                <p className="text-xs text-un1t-subtle mb-3">
                  Credit expires {dateLabel(loc.wallet.expires_on)} — the wallet is a monthly usage budget
                  and unused credit doesn&apos;t roll over.
                </p>

                {loc.wallet.lapse_warning && (
                  <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-sm rounded-lg p-3 mb-3">
                    {euro(loc.wallet.balance_cents)} of credit expires on {dateLabel(loc.wallet.expires_on)}.
                    Unused wallet credit lapses at the end of the month.
                  </div>
                )}

                {loc.wallet.ledger.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-un1t-subtle uppercase tracking-wide">
                          <th className="py-1.5 pr-4">Date</th>
                          <th className="py-1.5 pr-4">Type</th>
                          <th className="py-1.5 pr-4">Detail</th>
                          <th className="py-1.5 pr-4 text-right">Amount</th>
                          <th className="py-1.5 text-right">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loc.wallet.ledger.map((entry) => (
                          <tr key={entry.id} className="border-t border-un1t-border">
                            <td className="py-2 pr-4 whitespace-nowrap">{dateTimeLabel(entry.created_at)}</td>
                            <td className="py-2 pr-4"><KindChip kind={entry.kind} /></td>
                            <td className="py-2 pr-4 text-xs text-un1t-subtle">
                              {entry.meter
                                ? `${METERS[entry.meter]?.label || entry.meter}${entry.qty != null ? ` × ${Number(entry.qty).toLocaleString()}` : ''}`
                                : entry.note || '—'}
                            </td>
                            <td className={`py-2 pr-4 text-right tabular-nums ${entry.amount_cents < 0 ? 'text-red-700' : 'text-green-700'}`}>
                              {entry.amount_cents > 0 ? '+' : ''}{euro(entry.amount_cents)}
                            </td>
                            <td className="py-2 text-right tabular-nums">{euro(entry.balance_after_cents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-un1t-subtle">No wallet activity yet.</p>
                )}

                <WalletTopupButtons locationId={loc.location_id} />

                <AutoTopupForm
                  locationId={loc.location_id}
                  initialEnabled={loc.wallet.auto_topup.enabled}
                  initialAmountCents={loc.wallet.auto_topup.amount_cents}
                  initialThresholdCents={loc.wallet.auto_topup.threshold_cents}
                />
              </div>
            </div>
          ))}

          {/* Invoices — TU wallet top-up invoices (INTEG-C2b, last 24
              across the org, newest first). Subscription INV-nnnn
              invoices remain future work (Stripe-Billing track). */}
          <div className="mb-10">
            <div className="flex items-center gap-2 mb-3">
              <ReceiptText size={16} className="text-un1t-subtle" />
              <h2 className="text-lg font-semibold">Invoices</h2>
            </div>
            {data.invoices.length > 0 ? (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-un1t-subtle uppercase tracking-wide">
                        <th className="py-1.5 pr-4">Number</th>
                        <th className="py-1.5 pr-4">Date</th>
                        <th className="py-1.5 pr-4">Location</th>
                        <th className="py-1.5 pr-4 text-right">Total</th>
                        <th className="py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.invoices.map((inv) => (
                        <tr key={inv.id} className="border-t border-un1t-border">
                          <td className="py-2 pr-4 whitespace-nowrap font-medium">{inv.number}</td>
                          <td className="py-2 pr-4 whitespace-nowrap">{dateTimeLabel(inv.created_at)}</td>
                          <td className="py-2 pr-4">{inv.location_name}</td>
                          <td className="py-2 pr-4 text-right tabular-nums">{euro(inv.total_cents)}</td>
                          <td className="py-2"><InvoiceStatusChip status={inv.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-un1t-subtle mt-3">
                  Wallet top-up invoices (VAT invoiced at the point of top-up). Subscription
                  invoices will appear here when plan billing goes live.
                </p>
              </div>
            ) : (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-6 text-sm text-un1t-subtle">
                No invoices yet. Wallet top-up invoices appear here as soon as you make one;
                subscription invoices follow when plan billing goes live.
              </div>
            )}
          </div>

          {/* Billing contact — STILL no storage columns (C2b shipped
              top-ups without them by design); fields stay disabled until
              the billing-contact/VAT-number columns land with the
              Stripe-Billing subscription track. */}
          <div>
            <h2 className="text-lg font-semibold mb-3">Billing contact</h2>
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
                <label className="block text-sm">
                  <span className="text-un1t-subtle">Billing email</span>
                  <input
                    type="email"
                    disabled
                    placeholder="—"
                    className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm opacity-60 cursor-not-allowed"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-un1t-subtle">VAT number</span>
                  <input
                    type="text"
                    disabled
                    placeholder="—"
                    className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm opacity-60 cursor-not-allowed"
                  />
                </label>
              </div>
              <p className="text-xs text-un1t-subtle mt-3">
                Coming soon — billing contact and VAT number details ship with subscription billing.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
