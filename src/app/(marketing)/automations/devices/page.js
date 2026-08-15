// src/app/automations/devices/page.js — Tapo device control (TAPO-T1.5).
//
// Adopt bridge-reported devices, configure their schedule (none |
// fixed windows | class-linked), and manually toggle them. Gated on
// the `device_control` permission; the API routes it consumes
// (/api/tapo/*) enforce the same permission + location scope in app
// code (service-role routes get no RLS).
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import TapoDevicesClient from '@/components/automations/TapoDevicesClient'

export const dynamic = 'force-dynamic'

export default async function TapoDevicesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'device_control')) redirect('/automations')

  const location = user.activeLocation

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-un1t-text">Devices</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Smart plugs &amp; switches for {location?.name || 'your studio'} — schedules and class-linked power.
        </p>
      </div>
      <TapoDevicesClient locationName={location?.name || ''} />
    </div>
  )
}
