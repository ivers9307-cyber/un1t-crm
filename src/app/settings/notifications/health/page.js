// NOTIF.4 — push delivery health dashboard.
//
// Surfaces the gap audit caught: most staff at most locations have
// no device_tokens registered, so even when the cron fires the
// pushes land nowhere. Per-staff row shows a traffic-light status:
//
//   🟢 ≥1 token AND last_seen within 14 days
//   🟡 ≥1 token BUT last seen >14 days ago (app installed,
//       phone not opened recently — token may be silently stale)
//   🔴 0 tokens (app not installed, or push permission denied,
//       or the user is fully web-only)
//
// "Send test push" button per ≥1-token user posts to
// /api/admin/push/test, which fires a CATEGORYLESS push via the shared
// push.js — respects each user's push_notifications master switch and
// the OS device permission, and skips per-category notify_* gating by
// not having a category at all. It used to send category='test' on the
// belief that an unregistered key "fails open"; it fails CLOSED
// (resolvePermission's last tier is `defaults[role][key] === true`), so
// the button silently suppressed itself for every non-master — see
// PUSH-TEST.1 and the route's header. Same delivery path as real
// notifications, so it's still a true end-to-end test.
//
// Auth: master or owner. /settings/notifications already gates on
// hasPermission(user, 'settings') — same gate inherited here.
//
// STAFF-DEV.4 — this page is also the fleet view for app versions and
// geofence permission (it already loads every device_tokens row, so a
// second page would only be able to disagree with it). Version verdicts
// come from @/lib/staff-devices, shared with /api/staff-devices and the
// staff list; the clock is injected here so the lib stays pure.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ShieldCheck, Smartphone, Mail } from 'lucide-react'
import TestPushButton from '@/components/settings/TestPushButton'
import NudgeUpdateButton from '@/components/settings/NudgeUpdateButton'
import { deriveTargetVersion, deviceVerdict, currentDevice } from '@/lib/staff-devices'
import { geofencePermissionChip } from '@/lib/geofence-permission-chips'

export const dynamic = 'force-dynamic'

const HEALTHY_DAYS = 14

function fmtRelative(iso) {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30)  return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

function statusForUser(tokens, _pushesLast30d) {
  if (!tokens.length) return { kind: 'red', label: 'No app' }
  const newest = tokens.reduce((max, t) =>
    !max || (t.last_seen_at && t.last_seen_at > max) ? t.last_seen_at : max, null)
  if (!newest) return { kind: 'red', label: 'No app' }
  const daysSince = (Date.now() - new Date(newest).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince > HEALTHY_DAYS) return { kind: 'amber', label: 'Stale' }
  return { kind: 'green', label: 'Healthy' }
}

export default async function PushHealthPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'settings')) redirect('/')

  const db = createServerClient()

  // One round-trip per resource. Compose in JS — datasets are small
  // (~30 staff, ~few hundred device tokens at most).
  const [profilesRes, locationsRes, tokensRes, sendsRes, plRes] = await Promise.all([
    db.from('profiles').select('id, full_name, email, role, active').eq('active', true),
    db.from('locations').select('id, name, active').eq('active', true).eq('is_host_anchor', false).order('name'),
    db.from('device_tokens').select('id, user_id, platform, device_name, app_version, created_at, last_seen_at, geofence_permission, geofence_permission_at'),
    db.from('push_reminder_sends')
      .select('recipient_id, sent_at')
      .gte('sent_at', new Date(Date.now() - 30 * 86400 * 1000).toISOString()),
    db.from('profile_locations').select('profile_id, location_id'),
  ])

  const profiles = profilesRes.data || []
  const locations = locationsRes.data || []
  const tokens = tokensRes.data || []
  const sends = sendsRes.data || []
  const profileLocations = plRes.data || []

  // Pre-bucket
  const tokensByUser = new Map()
  for (const t of tokens) {
    if (!tokensByUser.has(t.user_id)) tokensByUser.set(t.user_id, [])
    tokensByUser.get(t.user_id).push(t)
  }
  const sendsByUser = new Map()
  for (const s of sends) {
    sendsByUser.set(s.recipient_id, (sendsByUser.get(s.recipient_id) || 0) + 1)
  }
  const profileLocByUser = new Map()
  for (const pl of profileLocations) {
    if (!profileLocByUser.has(pl.profile_id)) profileLocByUser.set(pl.profile_id, new Set())
    profileLocByUser.get(pl.profile_id).add(pl.location_id)
  }

  // Version verdicts (STAFF-DEV). One clock for the whole render, and
  // the target is derived from ACTIVE staff's devices only — a leaver's
  // newer phone must not mark everyone still here as outdated.
  const now = Date.now()
  const activeIds = new Set(profiles.map(p => p.id))
  const targetVersion = deriveTargetVersion(tokens.filter(t => activeIds.has(t.user_id)), now)

  // Group profiles by location for display. A profile can be at
  // multiple locations — show them under each (rare; only ~3 staff
  // hit this today).
  const groups = locations.map(loc => ({
    location: loc,
    profiles: profiles.filter(p => profileLocByUser.get(p.id)?.has(loc.id))
      .map(p => {
        const ownTokens = tokensByUser.get(p.id) || []
        return {
          ...p,
          tokens: ownTokens,
          pushesLast30d: sendsByUser.get(p.id) || 0,
          verdict: deviceVerdict(ownTokens, targetVersion, now),
          // Permission reads off the CURRENT device only — an old iPad
          // that once granted "always" says nothing about today's phone.
          permission: currentDevice(ownTokens)?.geofence_permission ?? null,
        }
      })
      .sort((a, b) => a.full_name.localeCompare(b.full_name || '')),
  }))

  // Rollup counts for the header
  const totals = {
    profiles: profiles.length,
    healthy: 0, stale: 0, no_app: 0,
    on_latest: 0,
    total_tokens: tokens.length,
  }
  for (const p of profiles) {
    const s = statusForUser(tokensByUser.get(p.id) || [], sendsByUser.get(p.id) || 0)
    if (s.kind === 'green') totals.healthy++
    else if (s.kind === 'amber') totals.stale++
    else totals.no_app++
    if (deviceVerdict(tokensByUser.get(p.id) || [], targetVersion, now).kind === 'current') {
      totals.on_latest++
    }
  }

  return (
    <div className="p-8 max-w-5xl">
      <Link
        href="/settings/notifications"
        className="inline-flex items-center gap-1.5 text-xs text-un1t-subtle hover:text-un1t-text mb-4"
      >
        <ArrowLeft size={12} /> Notification registry
      </Link>
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={20} className="text-un1t-subtle" />
        <h2 className="text-2xl font-bold">Push delivery health</h2>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        Per-staff device-token status. A push will only reach a phone if the staff member has the app installed, granted push permission, and opened it recently enough that their token is still valid.
      </p>

      {/* Rollup */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <SummaryCard label="Total staff" value={totals.profiles} kind="neutral" />
        <SummaryCard label="Healthy" value={totals.healthy} kind="green" />
        <SummaryCard label="Stale" value={totals.stale} kind="amber" />
        <SummaryCard label="No app installed" value={totals.no_app} kind="red" />
        <SummaryCard
          label="On latest"
          value={`${totals.on_latest}/${totals.profiles}`}
          kind="neutral"
          sub={targetVersion ? `v${targetVersion}` : 'no version reported'}
        />
      </div>

      {totals.no_app > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-6 text-xs text-amber-700">
          <strong className="font-semibold">{totals.no_app}</strong> of {totals.profiles} active staff have no device tokens registered.
          They won&apos;t receive any push notifications until they install the mobile app and grant push permission on first launch.
        </div>
      )}

      {groups.map(({ location, profiles }) => (
        <div key={location.id} className="mb-6 bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
          <div className="bg-un1t-border/30 px-4 py-2.5 border-b border-un1t-border flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-un1t-text">{location.name}</div>
            <div className="flex items-center gap-3">
              <div className="text-[11px] text-un1t-subtle">
                {profiles.length} staff
              </div>
              {/* STAFF-DEV.8 — recipients here are a PREVIEW. The route
                  recomputes who is outdated server-side and intersects,
                  so this list can never nominate an up-to-date staffer. */}
              <NudgeUpdateButton
                recipients={profiles
                  .filter(p => p.verdict.kind === 'outdated')
                  .map(p => ({ id: p.id, name: p.full_name, version: p.verdict.version }))}
              />
            </div>
          </div>
          {profiles.length === 0 ? (
            <div className="px-4 py-3 text-xs text-un1t-muted">No active staff at this location.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-un1t-subtle">
                <tr className="border-b border-un1t-border">
                  <th className="text-left px-4 py-2 font-medium">Name</th>
                  <th className="text-left px-4 py-2 font-medium">Role</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Devices</th>
                  <th className="text-left px-4 py-2 font-medium">App version</th>
                  <th className="text-left px-4 py-2 font-medium">Location permission</th>
                  <th className="text-left px-4 py-2 font-medium">Last seen</th>
                  <th className="text-left px-4 py-2 font-medium">Pushes 30d</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {profiles.map(p => {
                  const s = statusForUser(p.tokens, p.pushesLast30d)
                  const newestSeen = p.tokens.reduce((max, t) =>
                    !max || (t.last_seen_at && t.last_seen_at > max) ? t.last_seen_at : max, null)
                  return (
                    <tr key={p.id} className="border-b border-un1t-border/30 last:border-b-0">
                      <td className="px-4 py-2.5">
                        <div className="text-un1t-text">{p.full_name}</div>
                        <div className="text-[11px] text-un1t-muted">{p.email}</div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-un1t-subtle capitalize">{p.role.replace('_', ' ')}</td>
                      <td className="px-4 py-2.5"><StatusPill status={s} /></td>
                      <td className="px-4 py-2.5 text-xs text-un1t-subtle">
                        {p.tokens.length === 0 ? (
                          <span className="text-un1t-muted">—</span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Smartphone size={12} /> {p.tokens.length}
                            <span className="text-un1t-muted">
                              ({[...new Set(p.tokens.map(t => t.platform))].join(', ')})
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-un1t-subtle">
                        <VersionCell verdict={p.verdict} />
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <PermissionChip value={p.permission} />
                      </td>
                      <td className="px-4 py-2.5 text-xs text-un1t-subtle">{fmtRelative(newestSeen)}</td>
                      <td className="px-4 py-2.5 text-xs text-un1t-subtle">{p.pushesLast30d}</td>
                      <td className="px-4 py-2.5 text-right">
                        {p.tokens.length > 0 ? (
                          <TestPushButton recipientId={p.id} recipientName={p.full_name} />
                        ) : (
                          <a
                            href={`mailto:${p.email}?subject=${encodeURIComponent('Install the Repset mobile app')}&body=${encodeURIComponent('Hi ' + (p.full_name?.split(' ')[0] || '') + ',\n\nPlease install the Repset mobile app from TestFlight and grant push notification permission so you can receive task and booking reminders.\n\nThanks')}`}
                            className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded px-2 py-1"
                          >
                            <Mail size={11} /> Nudge
                          </a>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}

      <p className="text-xs text-un1t-muted mt-2">
        Stale = the device hasn&apos;t opened the app in {HEALTHY_DAYS}+ days. Token may still be valid; a test push tells you for sure.
        Tokens that come back DeviceNotRegistered from Expo are auto-pruned by src/lib/push.js.
      </p>
    </div>
  )
}

function SummaryCard({ label, value, kind, sub }) {
  const colors = {
    neutral: 'border-un1t-border text-un1t-text',
    green:   'border-emerald-500/40 text-emerald-700',
    amber:   'border-amber-500/40 text-amber-700',
    red:     'border-red-500/40 text-red-700',
  }
  return (
    <div className={`bg-un1t-surface border ${colors[kind]} rounded-lg p-3`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">{label}</div>
      {sub && <div className="text-[11px] text-un1t-muted mt-0.5">{sub}</div>}
    </div>
  )
}

// House chip recipe: bg-<c>-500/10 + the -700 text ramp. The amber pill
// previously used text-amber-200, which is invisible on this light
// surface (the palette has inverted token names) — fixed in STAFF-DEV.4.
const CHIP = 'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold'
const CHIP_TONE = {
  green:   'bg-emerald-500/10 text-emerald-700',
  amber:   'bg-amber-500/10 text-amber-700',
  red:     'bg-red-500/10 text-red-700',
  neutral: 'bg-un1t-border/40 text-un1t-subtle',
}

function StatusPill({ status }) {
  return <span className={`${CHIP} ${CHIP_TONE[status.kind]}`}>{status.label}</span>
}

// Current device's version + an Outdated chip. Never shows a version the
// person isn't actually running: the verdict keys off their newest
// device, not the best build they happen to own.
function VersionCell({ verdict }) {
  if (verdict.kind === 'no_device') return <span className="text-un1t-muted">—</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-un1t-text">{verdict.version || '—'}</span>
      {verdict.kind === 'outdated' && <span className={`${CHIP} ${CHIP_TONE.amber}`}>Outdated</span>}
    </span>
  )
}

// Background-location state for the CURRENT device. A null value means
// the device has never reported (client below 2.2.0, or pre-STAFF-DEV
// JS) and MUST render as "—" — absence of data is not a denial, and
// that distinction is the whole diagnostic point.
function PermissionChip({ value }) {
  // GEO-ATT.22 — labels/tones from the shared registry; null still renders "—".
  const chip = geofencePermissionChip(value)
  if (!chip) return <span className="text-un1t-muted">—</span>
  return <span className={`${CHIP} ${chip.className}`}>{chip.label}</span>
}
