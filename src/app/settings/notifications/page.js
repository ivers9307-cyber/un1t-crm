// NOTIF.3 — top-level notification registry page.
//
// Read-only catalogue of every push notification the CRM sends.
// For each category we surface:
//   - what triggers it (cron / event / webhook + the source path)
//   - who receives it (assignee / requester / roles-at-location)
//   - whether it's per-location configurable (and the current
//     effective config when it is — collapsed per-location strip)
//   - how many users currently have it enabled (count from
//     profiles.permissions.mobile.notify_<category>)
//
// Edit affordance: the per-location lead-time editor lives on the
// per-location settings page (mig 170 / NotificationConfigCard). This
// page links into it. Per-user toggles live in StaffForm.
//
// Auth: any settings-permission holder can view. Counts are
// aggregate (no PII).

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Bell, Clock, Users, User, Mail, Cog, Webhook, ChevronRight, ShieldCheck } from 'lucide-react'
import { NOTIFICATION_REGISTRY } from '@/lib/notifications-registry'
import { getEffectiveConfig, formatLeadTimes } from '@/lib/notification-config'

export const dynamic = 'force-dynamic'

function TriggerIcon({ kind }) {
  if (kind === 'cron')    return <Clock size={14} className="text-blue-400" />
  if (kind === 'webhook') return <Webhook size={14} className="text-violet-400" />
  return <Cog size={14} className="text-amber-400" />
}

function RecipientIcon({ kind }) {
  if (kind === 'roles_at_location') return <Users size={14} className="text-emerald-400" />
  if (kind === 'specific_user' || kind === 'individual_or_creator') return <User size={14} className="text-emerald-400" />
  return <Mail size={14} className="text-emerald-400" />
}

export default async function NotificationRegistryPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'settings')) redirect('/')

  const db = createServerClient()
  // Pull active profiles + locations once. Per-category enabled
  // counts are computed in JS — cheap (<200 profiles ever).
  const [{ data: profiles }, { data: locations }] = await Promise.all([
    db.from('profiles')
      .select('id, role, active, permissions')
      .eq('active', true),
    db.from('locations')
      .select('id, name, slug, active, notification_config')
      .eq('active', true)
      .eq('is_host_anchor', false)
      .order('name'),
  ])

  // Compute, for each notify_<category>, the enabled count.
  const enabledCounts = {}
  for (const cat of NOTIFICATION_REGISTRY.map(n => n.category)) {
    enabledCounts[cat] = (profiles || []).filter(p => {
      const m = p.permissions?.mobile || {}
      if (m.push_notifications === false) return false
      return m[`notify_${cat}`] !== false // undefined defaults to "on"
    }).length
  }
  const totalProfiles = (profiles || []).length

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center gap-2 mb-1">
        <Bell size={20} className="text-un1t-subtle" />
        <h2 className="text-2xl font-bold">Notification registry</h2>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        Every push notification the CRM sends. {totalProfiles} active staff member{totalProfiles === 1 ? '' : 's'} can receive notifications, subject to per-user toggles in their profile.
      </p>

      <Link
        href="/settings/notifications/health"
        className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors mb-6"
      >
        <div className="flex items-start gap-3">
          <ShieldCheck size={16} className="text-un1t-subtle mt-0.5" />
          <div>
            <div className="text-un1t-text">Delivery health</div>
            <div className="text-xs text-un1t-subtle mt-0.5">
              See which staff have the mobile app installed and tokens registered. Send test pushes to verify end-to-end delivery.
            </div>
          </div>
        </div>
        <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text" />
      </Link>

      <div className="space-y-3">
        {NOTIFICATION_REGISTRY.map(n => (
          <div
            key={n.category}
            className="bg-un1t-surface border border-un1t-border rounded-lg p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h3 className="text-base font-semibold text-un1t-text">{n.label}</h3>
                <p className="text-xs text-un1t-subtle mt-1">{n.description}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-xs">
                  <div className="flex items-start gap-1.5">
                    <TriggerIcon kind={n.trigger.kind} />
                    <div>
                      <div className="text-un1t-muted uppercase tracking-wider text-[10px]">Trigger</div>
                      <div className="text-un1t-text">{n.trigger.source}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <RecipientIcon kind={n.recipients.kind} />
                    <div>
                      <div className="text-un1t-muted uppercase tracking-wider text-[10px]">Recipients</div>
                      <div className="text-un1t-text">{n.recipients.detail}</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-2xl font-bold text-un1t-text">{enabledCounts[n.category]}</div>
                <div className="text-[10px] uppercase tracking-wider text-un1t-muted">opted in</div>
                <div className="text-[10px] text-un1t-muted">of {totalProfiles}</div>
              </div>
            </div>

            {(n.configurable.leadTimes || n.configurable.roles) && (
              <div className="mt-4 pt-4 border-t border-un1t-border">
                <div className="text-[10px] uppercase tracking-wider text-un1t-muted mb-2">
                  Per-location config
                </div>
                <div className="space-y-1">
                  {(locations || []).map(loc => {
                    const eff = getEffectiveConfig(loc.notification_config)
                    const slice = eff.categories?.[n.category] || {}
                    const usingDefault = !loc.notification_config?.categories?.[n.category]
                    return (
                      <Link
                        key={loc.id}
                        href={`/settings/locations/${loc.id}`}
                        className="flex items-center justify-between text-xs hover:bg-un1t-border/30 -mx-2 px-2 py-1.5 rounded group"
                      >
                        <span className="text-un1t-text">{loc.name}</span>
                        <span className="text-un1t-subtle flex items-center gap-2">
                          {n.configurable.leadTimes && (
                            <span>
                              Lead times: <span className="text-un1t-text font-mono">{formatLeadTimes(slice.lead_times_minutes)}</span>
                            </span>
                          )}
                          {n.configurable.roles && (
                            <span>
                              · Roles: <span className="text-un1t-text">{(slice.notify_roles || []).join(', ') || '—'}</span>
                            </span>
                          )}
                          {usingDefault && (
                            <span className="text-[10px] bg-un1t-border/40 px-1.5 py-0.5 rounded-full">default</span>
                          )}
                          <ChevronRight size={12} className="text-un1t-subtle group-hover:text-un1t-text" />
                        </span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="text-xs text-un1t-muted mt-6">
        Per-user opt-outs live in Settings → Team Members → [staff] → Mobile permissions.
        Per-location lead times for cron-driven categories are editable from each location&apos;s settings page.
      </p>
    </div>
  )
}
