'use client'

// INTEG-B1 — the Integrations hub (master-only rollout, phase B).
//
// Faithful product-code reproduction of the approved hub mockup
// (2026-07-19): page header with a location scope switcher, the
// status-model legend, a "Needs attention" strip, and a card grid in
// three tiers — Your integrations / Managed by the platform / Master
// view. Data comes pre-assembled from src/lib/integrations-hub.js
// (registry + xero_connections + whatsapp_numbers + ad_accounts);
// this component only filters by scope and renders.
//
// INTEG-C4 adds the plan & wallet strip at the top: pinned tier +
// wallet balance/expiry (with the late-month lapse warning) + MTD
// meter bars vs allowance. Read-only and pinning-gated — an unpinned
// scope (every UN1T location today) renders one quiet "No platform
// plan" line. The strip carries a "Manage plan" deep-link into the D1
// billing page (/settings/billing).
//
// The Email-delivery card reflects each org's tenant sending-domain
// state (INTEG-B3, tenant_email_domains): no row → platform email (the
// default for every org today), live → the custom domain, pending/
// verifying → setup in progress, failed/disabled → attention. It
// deep-links into the B3 wizard (/settings/email-domain). TikTok stays
// a static coming-soon card.
//
// SHELLY-UI.7 adds the Shelly plugs card (tier 1, after Meta Ads): the
// per-location connection grade plus adopted/online plug counts, read
// from shelly_connections + shelly_devices by the assembler. It is a
// pure DEEP LINK to /automations/shelly — no drawer, because the auth
// key is pasted on that page and a second connect form for it would be
// a second place to get the key wrong.
//
// Every action is a DEEP LINK into an existing surface — the per-location
// integrations tab (/settings/locations/<id>?tab=<key>), the email-domain
// wizard, or the billing page — no new mutation surface here, and the old
// tabs are untouched.

import { useCallback, useState } from 'react'
import Link from 'next/link'
import {
  Zap, MessageCircle, Landmark, Megaphone, Plug,
  Music2, Bot, Mail, MessageSquare, Bell, DoorOpen, Snowflake,
  CreditCard, FileCheck, Activity,
} from 'lucide-react'
import { Instagram as InstagramIcon } from '@/components/icons/InstagramIcon'
import { buttonClasses } from '@/components/ui'
import IntegrationsHubDrawer from './IntegrationsHubDrawer'

// ── status chips — the light-theme contrast recipe (bg-*-500/10 + text-*-700,
// lint-enforced via check:guardrails no-low-contrast-chip) ──
const CHIP_STYLES = {
  connected: 'bg-green-500/10 text-green-700',
  action_needed: 'bg-amber-500/10 text-amber-700',
  error: 'bg-red-500/10 text-red-700',
  not_connected: 'bg-zinc-500/10 text-zinc-700',
  platform: 'bg-blue-500/10 text-blue-700',
  coming_soon: 'border border-dashed border-un1t-border text-un1t-subtle',
}

const CHIP_LABELS = {
  connected: 'Connected',
  action_needed: 'Action needed',
  error: 'Error',
  not_connected: 'Not connected',
  platform: 'Platform-managed',
  coming_soon: 'Coming soon',
}

function StatusChip({ status, label }) {
  const style = CHIP_STYLES[status] || CHIP_STYLES.not_connected
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${style}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label || CHIP_LABELS[status] || status}
    </span>
  )
}

// Card-level aggregation of visible row statuses (scope-aware, so it
// lives client-side). Mirrors worstStatus() in src/lib/integrations-hub.js —
// kept local so this client bundle doesn't pull in server-side libs.
const STATUS_RANK = { error: 3, action_needed: 2, connected: 1, not_connected: 0 }
function worstOf(statuses) {
  let best = null
  for (const s of statuses) {
    if (!(s in STATUS_RANK)) continue
    if (best === null || STATUS_RANK[s] > STATUS_RANK[best]) best = s
  }
  return best === null ? 'not_connected' : best
}

function fmtDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Shelly plugs (SHELLY-UI.7) — per-location connection + device counts ──
//
// Every row deep-links to /automations/shelly, the ACTIVE-LOCATION page:
// by decision there is no per-location Shelly tab, so managing another
// studio's plugs means switching location first. The href is therefore
// identical on every row, and the location NAME on the row is what says
// which studio the numbers describe.

// "last OK" is measured against the payload's own generatedAt, never
// Date.now(). Two reasons, and both matter: both timestamps are then
// server-minted, so a skewed browser clock cannot invent a gap (the Sonos
// lesson — never compare a client clock to a server time); and the string
// is identical on the server render and on hydration, so it cannot trip a
// mismatch. Anything unmeasurable or older than a day falls back to the date.
function fmtAgo(iso, sinceIso) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  const since = new Date(sinceIso || '').getTime()
  if (Number.isNaN(t) || Number.isNaN(since)) return fmtDate(iso)
  const mins = Math.floor((since - t) / 60000)
  if (mins < 1) return 'just now' // includes a future stamp (clock skew)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return fmtDate(iso)
}

function plugs(n) {
  return `${n} plug${n === 1 ? '' : 's'}`
}

function shellyDetail(r, generatedAt) {
  // A never-connected location is the ordinary case; a DISCONNECTED one
  // that still has plugs adopted is not, and the count is the only thing
  // that tells them apart (the relays hold wherever they were left).
  if (r.status === 'not_connected') {
    return r.deviceCount > 0 ? `Not connected — ${plugs(r.deviceCount)} still adopted` : 'Not connected'
  }
  if (r.status !== 'connected') return r.message || 'Needs attention'
  const ago = fmtAgo(r.lastOkAt, generatedAt)
  const count = r.deviceCount === 0 ? 'no plugs adopted' : `${plugs(r.deviceCount)} (${r.onlineCount} online)`
  return [r.host, count, ago ? `last OK ${ago}` : null].filter(Boolean).join(' · ')
}

// Secondary line for a row that IS connected in the DB but needs hands:
// which account and which key, so a re-paste replaces the right one, plus
// when the cron last TRIED. "last checked" is lastAttemptAt (stamped on
// every reconcile tick, success or failure) — the answer to the only
// question a red badge raises: is it still retrying, or has nothing
// touched this in days? The hint is the last ≤4 characters of the key and
// is non-secret by the shelly connections allowlist.
function shellyContext(r, generatedAt) {
  if (r.status === 'connected' || r.status === 'not_connected' || !r.host) return null
  const checked = fmtAgo(r.lastAttemptAt, generatedAt)
  return [
    r.host,
    r.hasAuthKey ? `key ••••${r.keyHint}` : 'no key stored',
    r.deviceCount > 0 ? `${plugs(r.deviceCount)} (${r.onlineCount} online)` : 'no plugs adopted',
    checked ? `last checked ${checked}` : null,
  ].filter(Boolean).join(' · ')
}

// ── Email delivery (INTEG-B3) — per-org tenant sending-domain state ──
// The assembler grades each org into these statuses; the card reflects them.
const EMAIL_CHIP_LABELS = {
  platform: 'Platform email',
  connected: 'Custom domain',
  action_needed: 'Setup in progress',
  error: 'Attention',
}

const EMAIL_RANK = { error: 3, action_needed: 2, connected: 1, platform: 0 }
function emailCardStatus(entries) {
  let best = 'platform'
  for (const e of entries) {
    if ((EMAIL_RANK[e.status] ?? 0) > (EMAIL_RANK[best] ?? 0)) best = e.status
  }
  return best
}

function emailDetail(e) {
  switch (e.status) {
    case 'connected':
      return e.fromEmail
        ? `Sending from ${e.fromEmail}`
        : (e.sendingDomain ? `Custom domain ${e.sendingDomain} live` : 'Custom sending domain live')
    case 'action_needed':
      return `Custom domain setup in progress${e.sendingDomain ? ` · ${e.sendingDomain}` : ''}`
    case 'error':
      return 'Custom sending domain needs attention'
    default:
      return 'Sending via the platform email account'
  }
}

function Meter({ label, value, max, warn }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs text-un1t-subtle tabular-nums">
        <span>{label}</span>
        <span>{value.toLocaleString()} / {max.toLocaleString()}</span>
      </div>
      <div className="h-1.5 rounded-full bg-un1t-border/60 overflow-hidden">
        <div
          className={`h-full rounded-full ${warn ? 'bg-amber-600' : 'bg-un1t-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

const linkBtn = (primary = false) =>
  buttonClasses({ variant: primary ? 'primary' : 'secondary', size: 'sm' })

// ── Plan & wallet strip (INTEG-C4) ──

const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })
const fmtEurCents = (cents) => eur.format((Number(cents) || 0) / 100)

// Usage-vs-allowance bar: fill caps at 100%; past the allowance the
// numbers flip to the red -700 ramp (chip-contrast rule for light
// cards) with the "+N over · €X.XX drawn" suffix.
function PlanMeter({ label, used, allowance, overQty, overageDrawnCents }) {
  const pct = allowance > 0
    ? Math.min(100, Math.round((used / allowance) * 100))
    : (used > 0 ? 100 : 0)
  const over = overQty > 0
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className="text-un1t-subtle truncate">{label}</span>
        <span className={`whitespace-nowrap ${over ? 'text-red-700 font-semibold' : 'text-un1t-subtle'}`}>
          {used.toLocaleString()} / {allowance.toLocaleString()}
          {over && <> · +{overQty.toLocaleString()} over · {fmtEurCents(overageDrawnCents)} drawn</>}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-un1t-border/60 overflow-hidden">
        <div
          className={`h-full rounded-full ${over ? 'bg-red-600' : 'bg-un1t-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// One pinned location's strip row: plan name/price · wallet balance
// with expiry (+ lapse warning) · the three meter bars. Read-only —
// mutations happen on the D1 billing page, reached via Manage plan.
function BillingStripRow({ row, locationName, showLocation }) {
  const { plan, wallet, meters } = row
  return (
    <div className="rounded-xl border border-un1t-border bg-white p-4 flex flex-col lg:flex-row gap-4 lg:gap-8">
      <div className="lg:w-52 shrink-0">
        <div className="text-[10px] uppercase tracking-wider text-un1t-muted">
          Plan{showLocation && locationName ? ` · ${locationName}` : ''}
        </div>
        <div className="text-sm font-semibold text-un1t-text mt-1">
          {plan.name}
          <span className="text-un1t-subtle font-normal"> · {fmtEurCents(plan.priceCents)}/mo</span>
        </div>
        <p className="text-xs text-un1t-muted mt-0.5">Pricing version effective {fmtDate(plan.effectiveFrom)}</p>
        {plan.addons?.length > 0 && (
          <p className="text-xs text-un1t-muted mt-0.5">
            + {plan.addons.map((a) => a.name).join(', ')}
          </p>
        )}
        <div className="flex gap-2 pt-2">
          <Link href="/settings/billing" className={linkBtn()}>Manage plan</Link>
        </div>
      </div>
      <div className="lg:w-56 shrink-0">
        <div className="text-[10px] uppercase tracking-wider text-un1t-muted">Wallet</div>
        <div className="text-sm font-semibold text-un1t-text tabular-nums mt-1">{fmtEurCents(wallet.balanceCents)}</div>
        <p className="text-xs text-un1t-muted mt-0.5">expires {fmtDate(wallet.expiresOn)}</p>
        {wallet.lapseWarning && (
          <p className="text-xs text-amber-700 bg-amber-500/10 rounded px-2 py-1 mt-1.5">
            {fmtEurCents(wallet.balanceCents)} unused credit expires with the monthly reset.
          </p>
        )}
      </div>
      <div className="flex-1 grid gap-3 content-center">
        {meters.map((m) => (
          <PlanMeter
            key={m.key}
            label={m.label}
            used={m.used}
            allowance={m.allowance}
            overQty={m.overQty}
            overageDrawnCents={m.overageDrawnCents}
          />
        ))}
      </div>
    </div>
  )
}

function HubCard({ icon: Icon, title, locTag, provider, chip, dashed, muted, children }) {
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-3 transition-colors ${
      dashed
        ? 'border-dashed border-un1t-border bg-transparent'
        : muted
          ? 'border-un1t-border bg-un1t-surface'
          : 'border-un1t-border bg-white hover:border-un1t-muted/60'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`h-9 w-9 rounded-lg grid place-items-center shrink-0 ${
          dashed ? 'border border-dashed border-un1t-border text-un1t-muted' : 'bg-un1t-surface text-un1t-text border border-un1t-border'
        }`} aria-hidden="true">
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-un1t-text flex items-center gap-2 flex-wrap">
            {title}
            {locTag && (
              <span className="text-[10px] font-semibold text-un1t-subtle bg-un1t-surface border border-un1t-border rounded px-1.5 py-px">
                {locTag}
              </span>
            )}
          </h3>
          {provider && <p className="text-xs text-un1t-muted mt-0.5">{provider}</p>}
        </div>
        {chip}
      </div>
      {children}
    </div>
  )
}

function SectionHead({ title, sub, hidden }) {
  return (
    <div className="mt-10 mb-3">
      <h2 className={`text-xs font-bold uppercase tracking-wider flex items-center gap-2 ${hidden ? 'text-un1t-muted' : 'text-un1t-subtle'}`}>
        {title}
        {hidden && (
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border border-dashed border-un1t-border text-un1t-subtle normal-case tracking-normal">
            Only you see this section
          </span>
        )}
      </h2>
      {sub && <p className="text-xs text-un1t-muted mt-1 max-w-3xl">{sub}</p>}
    </div>
  )
}

const DOT = {
  error: 'bg-red-600',
  warning: 'bg-amber-600',
  info: 'bg-blue-600',
}

export default function IntegrationsHub({ data: initialData, isMaster = false }) {
  const [scope, setScope] = useState('all')
  // The hub payload is held in state so a save inside the Manage drawer can
  // re-grade in place: after connect/disconnect the drawer's onChanged fires
  // one scoped GET /api/integrations/hub (the same org-scoped route that seeded
  // this page) and swaps the payload — updating every card chip + the attention
  // strip without a full navigation. Last-good is kept on a failed refetch.
  const [data, setData] = useState(initialData)
  // The per-card Manage drawer. Keyed by (cardKey, locationId) — Ads/IG are
  // per-location, so the drawer always targets one location's connection.
  const [managing, setManaging] = useState(null)

  const refetchHub = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/hub', { credentials: 'same-origin' })
      const j = await res.json().catch(() => ({}))
      if (j.success && j.data) setData(j.data)
    } catch {
      /* keep last-good payload — the drawer's own UI already showed the save result */
    }
  }, [])

  const locations = data.locations || []
  const nameById = Object.fromEntries(locations.map((l) => [l.id, l.name]))
  const inScope = (locationId) => scope === 'all' || locationId === scope

  const glofox = (data.glofox || []).filter((r) => inScope(r.locationId))
  const whatsapp = (data.whatsapp || []).filter((r) => inScope(r.locationId))
  const instagram = (data.instagram || []).filter((r) => inScope(r.locationId))
  const xero = (data.xero || []).filter((r) => inScope(r.locationId))
  const ads = (data.ads || []).filter((r) => inScope(r.locationId))
  const shelly = (data.shelly || []).filter((r) => inScope(r.locationId))
  const sms = (data.sms || []).filter((r) => inScope(r.locationId))
  const agent = (data.agent || []).filter((r) => inScope(r.locationId))
  // Email delivery is per-ORG; keep an org row when any of its (scoped)
  // locations is in the selected location scope.
  const email = (data.email || []).filter((e) => scope === 'all' || (e.locationIds || []).includes(scope))
  const unifi = (data.unifi || []).filter((r) => inScope(r.locationId))
  const climate = (data.climate || []).filter((r) => inScope(r.locationId))
  const bca = (data.bca || []).filter((r) => inScope(r.locationId))
  const attention = (data.attention || []).filter((r) => inScope(r.locationId))
  const billing = (data.billing || []).filter((r) => inScope(r.locationId))
  const pinnedBilling = billing.filter((r) => r.plan)

  const scopeTag = scope === 'all'
    ? (arr) => (arr.length > 1 ? `${arr.length} locations` : (arr[0] ? nameById[arr[0].locationId] : null))
    : () => nameById[scope]

  return (
    <div className="p-8 max-w-6xl">
      {/* ── Header ── */}
      <div className="text-xs text-un1t-muted mb-1">Settings <span className="text-un1t-subtle font-medium">/ Integrations</span></div>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-2">
        <div>
          <h2 className="text-2xl font-bold">Integrations</h2>
          <p className="text-sm text-un1t-subtle mt-0.5 max-w-xl">
            Connect the tools your gym runs on. Connections belong to a location, so each site can run its own accounts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-un1t-muted">Location</span>
          <div className="inline-flex gap-0.5 rounded-lg border border-un1t-border bg-white p-0.5" role="group" aria-label="Location scope">
            <button
              type="button"
              aria-pressed={scope === 'all'}
              onClick={() => setScope('all')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                scope === 'all' ? 'bg-un1t-accent text-white' : 'text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              All locations
            </button>
            {locations.map((l) => (
              <button
                key={l.id}
                type="button"
                aria-pressed={scope === l.id}
                onClick={() => setScope(l.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  scope === l.id ? 'bg-un1t-accent text-white' : 'text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Status-model legend ── */}
      <div className="flex flex-wrap items-center gap-2 mt-3 mb-6" aria-label="Status legend">
        <span className="text-[10px] uppercase tracking-wider text-un1t-muted mr-1">Status model</span>
        <StatusChip status="connected" />
        <StatusChip status="action_needed" />
        <StatusChip status="error" />
        <StatusChip status="not_connected" />
        <StatusChip status="coming_soon" />
        <StatusChip status="platform" />
      </div>

      {/* ── Plan & wallet strip (INTEG-C4) — read-only, pinning-gated ──
          Manage-plan deep-links into the D1 billing page (/settings/billing,
          owner+/master). */}
      <div className="space-y-3 mb-6">
        {pinnedBilling.length === 0 ? (
          <div className="rounded-xl border border-un1t-border bg-white px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-un1t-subtle">
              No platform plan{scope !== 'all' && nameById[scope] ? ` — ${nameById[scope]}` : ''}
            </span>
            <Link href="/settings/billing" className={linkBtn()}>Manage plan</Link>
          </div>
        ) : pinnedBilling.map((row) => (
          <BillingStripRow
            key={row.locationId}
            row={row}
            locationName={nameById[row.locationId]}
            showLocation={scope === 'all'}
          />
        ))}
      </div>

      {/* ── Needs attention ── */}
      <div className="rounded-xl border border-un1t-border bg-white mb-6">
        <div className="px-4 pt-3 pb-2 text-xs font-bold uppercase tracking-wide text-un1t-subtle">
          Needs attention · {attention.length}
        </div>
        {attention.length === 0 ? (
          <div className="border-t border-un1t-border px-4 py-3 text-sm text-un1t-subtle">
            All connections healthy — nothing needs you right now.
          </div>
        ) : attention.map((a, i) => (
          <div key={`${a.cardKey}-${a.locationId}-${i}`} className="flex flex-wrap items-center gap-3 border-t border-un1t-border px-4 py-2.5 text-sm">
            <span className={`h-2 w-2 rounded-full shrink-0 ${DOT[a.severity] || DOT.info}`} aria-hidden="true" />
            <span className="flex-1 min-w-[200px] text-un1t-text">
              <span className="font-semibold">{a.label}</span>
              {scope === 'all' && a.locationName ? <span className="text-un1t-subtle"> · {a.locationName}</span> : null}
              <span className="text-un1t-subtle">: {a.message}</span>
            </span>
            <Link href={a.href} className={linkBtn()}>Open</Link>
          </div>
        ))}
      </div>

      {/* ══ Tier 1 — Your integrations ══ */}
      <SectionHead
        title="Your integrations"
        sub="Connect, test and disconnect these yourself. Connecting is owner-only; other staff see read-only health. Anything that needs you shows up in the strip above."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

        {/* Glofox — per-location rows */}
        <HubCard
          icon={Zap}
          title="Glofox"
          locTag={scopeTag(glofox)}
          provider="Bookings, members & payments sync"
          chip={<StatusChip status={worstOf(glofox.map((r) => r.status))} />}
        >
          <div className="divide-y divide-un1t-border border-t border-un1t-border text-sm">
            {glofox.map((r) => (
              <div key={r.locationId} className="flex items-center gap-3 py-2">
                <span className="font-semibold min-w-[88px]">{nameById[r.locationId]}</span>
                <span className="flex-1 text-xs text-un1t-subtle truncate">
                  {r.status === 'not_connected'
                    ? 'Not connected'
                    : <>Branch {r.branchId ? `${String(r.branchId).slice(0, 6)}…${String(r.branchId).slice(-4)}` : '—'}{r.lastOkAt ? ` · last OK ${fmtDate(r.lastOkAt)}` : ''}</>}
                </span>
                <button
                  type="button"
                  onClick={() => setManaging({ cardKey: 'glofox', locationId: r.locationId, initial: r })}
                  className={linkBtn(r.status === 'not_connected')}
                >
                  {r.status === 'not_connected' ? 'Connect' : 'Manage'}
                </button>
              </div>
            ))}
          </div>
        </HubCard>

        {/* WhatsApp — per-location numbers + tier budget meter */}
        <HubCard
          icon={MessageCircle}
          title="WhatsApp"
          locTag={scopeTag(whatsapp)}
          provider="Meta Cloud API · Embedded Signup"
          chip={<StatusChip status={worstOf(whatsapp.map((r) => r.status))} />}
        >
          <div className="divide-y divide-un1t-border border-t border-un1t-border text-sm">
            {whatsapp.map((r) => (
              <div key={r.locationId} className="py-2 space-y-1.5">
                <div className="flex items-center gap-3">
                  <span className="font-semibold min-w-[88px]">{nameById[r.locationId]}</span>
                  <span className="flex-1 text-xs text-un1t-subtle truncate">
                    {r.numbers.length === 0
                      ? 'No number yet'
                      : r.numbers.map((n) => (n.displayPhone ? `${n.displayPhone} “${n.label}”` : n.label)).join(' · ')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setManaging({ cardKey: 'whatsapp', locationId: r.locationId, initial: r })}
                    className={linkBtn(r.numbers.length === 0)}
                  >
                    {r.numbers.length === 0 ? 'Connect' : 'Manage'}
                  </button>
                </div>
                {r.numbers.filter((n) => n.message).map((n) => (
                  <p key={n.id} className="text-xs text-red-700 bg-red-500/10 rounded px-2 py-1">{n.message}</p>
                ))}
                {r.budget && (
                  <Meter
                    label={`Business-initiated conversations · rolling 24h (${(r.budget.tier || '').replace('TIER_', 'Tier ')})`}
                    value={r.budget.used}
                    max={r.budget.limit}
                    warn={r.budget.remaining / Math.max(1, r.budget.limit) < 0.2}
                  />
                )}
              </div>
            ))}
          </div>
        </HubCard>

        {/* Instagram */}
        <HubCard
          icon={InstagramIcon}
          title="Instagram"
          locTag={instagram.length ? nameById[instagram[0].locationId] : scopeTag(instagram)}
          provider={instagram[0]?.displayName ? `${instagram[0].displayName} · Instagram DMs` : 'Instagram DMs'}
          chip={<StatusChip status={worstOf(instagram.map((r) => r.status))} />}
        >
          {instagram.length === 0 ? (
            <>
              <p className="text-xs text-un1t-subtle">No Instagram connection{scope === 'all' ? '' : ' at this location'} yet.</p>
              <div className="flex gap-2 pt-1 mt-auto">
                {(scope === 'all' ? locations : locations.filter((l) => l.id === scope)).slice(0, 1).map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setManaging({ cardKey: 'instagram', locationId: l.id })}
                    className={linkBtn(true)}
                  >
                    Connect
                  </button>
                ))}
              </div>
            </>
          ) : instagram.map((r) => (
            <div key={r.locationId} className="space-y-2">
              <div className="text-xs text-un1t-subtle space-y-0.5">
                {r.lastOkAt && <p>· Last activity {fmtDate(r.lastOkAt)}</p>}
                {r.lastError && <p className="text-red-700">· {r.lastError}</p>}
              </div>
              {r.tokenDaysLeft != null && (
                <Meter
                  label="Token lifetime (60 days)"
                  value={Math.max(0, 60 - Math.max(0, r.tokenDaysLeft))}
                  max={60}
                  warn={r.tokenDaysLeft <= data.expirySoonDays}
                />
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setManaging({ cardKey: 'instagram', locationId: r.locationId })}
                  className={linkBtn(r.status !== 'connected')}
                >
                  {r.status === 'connected' ? 'Manage' : 'Reconnect'}
                </button>
              </div>
            </div>
          ))}
        </HubCard>

        {/* Xero */}
        <HubCard
          icon={Landmark}
          title="Xero"
          locTag={xero.length ? nameById[xero[0].locationId] : scopeTag(xero)}
          provider="Accounting — invoices & bills"
          chip={<StatusChip status={worstOf(xero.map((r) => r.status))} />}
        >
          {xero.length === 0 ? (
            <>
              <p className="text-xs text-un1t-subtle">No Xero organisation connected{scope === 'all' ? '' : ' at this location'}.</p>
              <div className="flex gap-2 pt-1 mt-auto">
                {(scope === 'all' ? locations : locations.filter((l) => l.id === scope)).slice(0, 1).map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setManaging({ cardKey: 'xero', locationId: l.id })}
                    className={linkBtn(true)}
                  >
                    Connect
                  </button>
                ))}
              </div>
            </>
          ) : xero.map((r) => (
            <div key={r.locationId} className="space-y-2">
              <div className="text-xs text-un1t-subtle space-y-0.5">
                <p>· Connected to <span className="text-un1t-text font-medium">{r.tenantName}</span></p>
                {r.connectedAt && <p>· Linked {fmtDate(r.connectedAt)}{r.lastRefreshedAt ? ` · refreshed ${fmtDate(r.lastRefreshedAt)}` : ''}</p>}
                {r.scopes?.length > 0 && <p title={r.scopes.join(' ')}>· {r.scopes.length} scopes granted</p>}
              </div>
              {r.message && (
                <p className="text-xs text-red-700 bg-red-500/10 rounded px-2 py-1.5">{r.message}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setManaging({ cardKey: 'xero', locationId: r.locationId, initial: r })}
                  className={linkBtn(r.status === 'error')}
                >
                  {r.status === 'error' ? 'Reconnect' : 'Manage'}
                </button>
              </div>
            </div>
          ))}
        </HubCard>

        {/* Meta Ads */}
        <HubCard
          icon={Megaphone}
          title="Meta Ads"
          locTag={ads.length ? nameById[ads[0].locationId] : scopeTag(ads)}
          provider={ads[0]?.externalAccountId ? `Ad account ${ads[0].externalAccountId}` : 'Spend & attribution reporting'}
          chip={<StatusChip status={worstOf(ads.map((r) => r.status))} />}
        >
          {ads.length === 0 ? (
            <p className="text-xs text-un1t-subtle">No ad account connected{scope === 'all' ? '' : ' at this location'} yet.</p>
          ) : (
            <div className="text-xs text-un1t-subtle space-y-0.5">
              {ads.map((r) => (
                <p key={`${r.locationId}-${r.externalAccountId}`}>
                  · {nameById[r.locationId]}: {r.displayName || r.externalAccountId}
                </p>
              ))}
              <p>· Spend & attribution sync nightly</p>
            </div>
          )}
          <div className="flex gap-2 pt-1 mt-auto">
            {(ads[0]
              ? [{ id: ads[0].locationId }]
              : (scope === 'all' ? locations : locations.filter((l) => l.id === scope)).slice(0, 1)
            ).map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setManaging({ cardKey: 'ads', locationId: l.id })}
                className={linkBtn(ads.length === 0)}
              >
                {ads.length === 0 ? 'Connect' : 'Manage'}
              </button>
            ))}
          </div>
        </HubCard>

        {/* Shelly plugs — per-location connection grade + adopted device counts */}
        <HubCard
          icon={Plug}
          title="Shelly plugs"
          locTag={scopeTag(shelly)}
          provider="Smart plugs — power schedules, live toggle & energy"
          chip={<StatusChip status={worstOf(shelly.map((r) => r.status))} />}
        >
          {shelly.length === 0 ? (
            <p className="text-xs text-un1t-subtle">Nothing to show for this location scope.</p>
          ) : (
            <div className="divide-y divide-un1t-border border-t border-un1t-border text-sm">
              {shelly.map((r) => (
                <div key={r.locationId} className="py-2 space-y-1">
                  <div className="flex items-center gap-3">
                    <span className="font-semibold min-w-[88px]">{nameById[r.locationId] || r.locationName}</span>
                    <span className={`flex-1 text-xs truncate ${
                      r.status === 'error'
                        ? 'text-red-700'
                        : r.status === 'action_needed' ? 'text-amber-700' : 'text-un1t-subtle'
                    }`}>
                      {shellyDetail(r, data.generatedAt)}
                    </span>
                    {/* Deep link, not a drawer: the plugs are managed on the
                        active-location page (see the header note above). */}
                    <Link href={r.href} className={linkBtn(r.status === 'not_connected')}>
                      {r.status === 'not_connected' ? 'Connect' : 'Manage'}
                    </Link>
                  </div>
                  {shellyContext(r, data.generatedAt) && (
                    <p className="text-[11px] text-un1t-muted truncate">{shellyContext(r, data.generatedAt)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </HubCard>

        {/* TikTok Ads — static coming soon */}
        <HubCard
          icon={Music2}
          title="TikTok Ads"
          provider="Spend & attribution reporting"
          chip={<StatusChip status="coming_soon" />}
          muted
        >
          <p className="text-xs text-un1t-subtle">On the roadmap. Tell us if you need it sooner.</p>
        </HubCard>
      </div>

      {/* ══ Tier 2 — Managed by the platform ══ */}
      <SectionHead
        title="Managed by the platform"
        sub="These run for every gym out of the box. Nothing to connect; shown here so you can see health at a glance."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

        {/* AI agent */}
        <HubCard
          icon={Bot}
          title="AI agent"
          provider="Answers WhatsApp & Instagram, books classes"
          chip={<StatusChip status="platform" />}
          muted
        >
          <div className="text-xs text-un1t-subtle space-y-0.5">
            {agent.map((r) => (
              <p key={r.locationId}>
                · {nameById[r.locationId]}:{' '}
                {r.mode === 'live' && <span className="font-medium text-green-700">live{r.agentName ? ` as ${r.agentName}` : ''}</span>}
                {r.mode === 'test' && <span className="font-medium text-amber-700">test mode (allow-list only)</span>}
                {r.mode === 'off' && 'off'}
              </p>
            ))}
          </div>
          <div className="flex gap-2 pt-1 mt-auto">
            <Link href="/settings/customer-agent" className={linkBtn()}>Agent settings</Link>
            <Link href="/communications/inbox" className={linkBtn()}>Conversations</Link>
          </div>
        </HubCard>

        {/* Email delivery — reflects each org's tenant sending-domain state (INTEG-B3) */}
        <HubCard
          icon={Mail}
          title="Email delivery"
          provider="Receipts, confirmations, campaigns"
          chip={<StatusChip status={emailCardStatus(email)} label={email.length === 0 ? CHIP_LABELS.platform : EMAIL_CHIP_LABELS[emailCardStatus(email)]} />}
          muted
        >
          {email.length === 0 ? (
            <p className="text-xs text-un1t-subtle">· Sending via the platform email account</p>
          ) : (
            <div className="divide-y divide-un1t-border border-t border-un1t-border text-sm">
              {email.map((e) => {
                const showOrg = email.length > 1 && e.orgName
                const attention = e.status === 'error' || e.status === 'action_needed'
                return (
                  <div key={e.organizationId} className="py-2 space-y-1.5">
                    <div className="flex items-center gap-3">
                      {showOrg && <span className="font-semibold min-w-[88px]">{e.orgName}</span>}
                      <span className="flex-1 text-xs text-un1t-subtle truncate">{emailDetail(e)}</span>
                      <StatusChip status={e.status} label={EMAIL_CHIP_LABELS[e.status]} />
                    </div>
                    {e.status === 'error' && e.lastError && (
                      <p className="text-xs text-red-700 bg-red-500/10 rounded px-2 py-1">{e.lastError}</p>
                    )}
                    <div className="flex gap-2">
                      <Link href={e.href} className={linkBtn(attention)}>
                        {e.status === 'platform' ? 'Set up domain' : 'Open'}
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </HubCard>

        {/* SMS */}
        <HubCard
          icon={MessageSquare}
          title="SMS"
          provider="One-way utility texts"
          chip={<StatusChip status="platform" />}
          muted
        >
          <div className="text-xs text-un1t-subtle space-y-0.5">
            {sms.map((r) => (
              <p key={r.locationId}>
                · {nameById[r.locationId]}: sender ID{' '}
                {r.senderId ? <span className="font-medium text-un1t-text">{r.senderId}</span> : <span>platform default</span>}
              </p>
            ))}
            <p>· Delivery via the platform account</p>
          </div>
          <div className="flex gap-2 pt-1 mt-auto">
            {sms.slice(0, 1).map((r) => (
              <button
                key={r.locationId}
                type="button"
                onClick={() => setManaging({ cardKey: 'sms', locationId: r.locationId, initial: r })}
                className={linkBtn()}
              >
                Edit sender ID
              </button>
            ))}
          </div>
        </HubCard>

        {/* Push notifications */}
        <HubCard
          icon={Bell}
          title="Push notifications"
          provider="Staff app & member app"
          chip={<StatusChip status="platform" />}
          muted
        >
          <p className="text-xs text-un1t-subtle">· Delivered via the platform&apos;s push service</p>
        </HubCard>
      </div>

      {/* ══ Tier 3 — Master view (hidden from tenants) ══
          B4: the hub is now owner-visible, so this master-only tier —
          UN1T studio customisation (UniFi/Climate) + org-gated/excluded
          cards — is rendered ONLY for masters. Without this gate an
          owner would see a section literally headed "Only you see this
          section". Data is org-scoped upstream regardless. */}
      {isMaster && (
      <>
      <SectionHead
        title="Master view · hidden from tenants"
        hidden
        sub="Org-gated, excluded, or UN1T studio customisation. Tenants never see these cards; platform OAuth apps (Garmin, Apple Health) stay in /settings/service-credentials."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

        {/* UniFi Access */}
        <HubCard
          icon={DoorOpen}
          title="UniFi Access"
          locTag={unifi.length ? nameById[unifi[0].locationId] : null}
          provider="Door access · gym entry"
          chip={<StatusChip status={worstOf(unifi.map((r) => r.status))} />}
          dashed
        >
          <div className="text-xs text-un1t-subtle space-y-0.5">
            <p>· UN1T studio customisation · not offered to tenants</p>
            {unifi.map((r) => r.lastError && <p key={r.locationId} className="text-red-700">· {r.lastError}</p>)}
          </div>
          <div className="flex gap-2 pt-1 mt-auto">
            {unifi.slice(0, 1).map((r) => (
              <button
                key={r.locationId}
                type="button"
                onClick={() => setManaging({ cardKey: 'unifi', locationId: r.locationId, initial: r })}
                className={linkBtn()}
              >
                Manage
              </button>
            ))}
          </div>
        </HubCard>

        {/* Climate devices */}
        <HubCard
          icon={Snowflake}
          title="Climate devices"
          locTag={climate.length ? nameById[climate[0].locationId] : null}
          provider={climate[0]?.vendors?.map((v) => (v.vendor === 'thinq' ? 'LG ThinQ' : 'Sensibo')).join(' + ') || 'Sensibo · LG ThinQ'}
          chip={<StatusChip status={worstOf(climate.map((r) => r.status))} />}
          dashed
        >
          <div className="text-xs text-un1t-subtle space-y-0.5">
            <p>· UN1T studio customisation · not offered to tenants</p>
            {climate.flatMap((r) => r.vendors.filter((v) => v.lastError).map((v) => (
              <p key={`${r.locationId}-${v.vendor}`} className="text-red-700">· {v.lastError}</p>
            )))}
          </div>
          <div className="flex gap-2 pt-1 mt-auto">
            {climate.slice(0, 1).map((r) => (
              <button
                key={r.locationId}
                type="button"
                onClick={() => setManaging({ cardKey: 'climate', locationId: r.locationId, initial: r })}
                className={linkBtn()}
              >
                Manage
              </button>
            ))}
          </div>
        </HubCard>

        {/* Revolut Merchant — org-gated, static */}
        <HubCard
          icon={CreditCard}
          title="Revolut Merchant"
          provider="Car deposits · pay.ccfautos.com"
          chip={<StatusChip status="not_connected" label="CCF Autos only" />}
          dashed
        >
          <p className="text-xs text-un1t-subtle">· Org-gated to CCF Autos. Not offered to gym tenants.</p>
        </HubCard>

        {/* BCA Submit */}
        <HubCard
          icon={FileCheck}
          title="BCA Submit"
          provider="Vehicle auction submissions"
          chip={bca.length
            ? <StatusChip status={worstOf(bca.map((r) => r.status))} />
            : <StatusChip status="not_connected" label="CCF Autos only" />}
          dashed
        >
          <p className="text-xs text-un1t-subtle">· Org-gated to CCF Autos. Not offered to gym tenants.</p>
          {bca.length > 0 && (
            <div className="flex gap-2 pt-1 mt-auto">
              <button
                type="button"
                onClick={() => setManaging({ cardKey: 'bca', locationId: bca[0].locationId, initial: bca[0] })}
                className={linkBtn()}
              >
                Manage
              </button>
            </div>
          )}
        </HubCard>

        {/* Strava — excluded from SaaS, static */}
        <HubCard
          icon={Activity}
          title="Strava"
          provider="Workout export for members"
          chip={<StatusChip status="not_connected" label="Excluded from SaaS" />}
          dashed
        >
          <p className="text-xs text-un1t-subtle">
            · Strava&apos;s API terms are personal-scope only; can&apos;t be resold to tenants. Stays on for UN1T&apos;s own members.
          </p>
        </HubCard>
      </div>
      </>
      )}

      <p className="mt-10 pt-4 border-t border-un1t-border text-xs text-un1t-muted max-w-3xl">
        Glofox, Twilio, UniFi, Climate, BCA, Meta Ads, Instagram, Xero and WhatsApp now connect and
        disconnect right here in a Manage panel — secrets stay write-only (leave a field blank to
        keep it); Xero connects over its OAuth redirect and WhatsApp over Meta&apos;s guided signup,
        with the heavy config one click away. The remaining cards (email delivery, billing)
        deep-link into the surface that owns them. The plan &amp; wallet strip itself is read-only.
      </p>

      {/* Per-card Manage drawer — Ads/Instagram (Phase 1) + Glofox/Twilio/
          UniFi/Climate/BCA credential forms (Phase 2) + Xero/WhatsApp
          connect/disconnect (Phase 3). `initial` is the matched hub row so
          the panel prefills state (Xero tenant/status, WhatsApp numbers) —
          absent for a not-yet-connected Xero location; `isMaster` gates the
          master-only credential providers read-only. */}
      {managing && (
        <IntegrationsHubDrawer
          cardKey={managing.cardKey}
          locationId={managing.locationId}
          locationName={nameById[managing.locationId] || null}
          initial={managing.initial}
          isMaster={isMaster}
          onClose={() => setManaging(null)}
          onChanged={refetchHub}
        />
      )}
    </div>
  )
}
