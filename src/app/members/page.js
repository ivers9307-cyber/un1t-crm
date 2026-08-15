// /members — Members hub index. Mirrors /sales (HUBS.2a): the sidebar's
// single Members entry points here; the hub's surfaces keep their own
// URLs. Redirect to the first tab this user can see, in tab order.
// Gate keys mirror each PAGE's own gate (bookings page checks `bookings`,
// events checks `races`, etc.), not the old nav entries' looser gates.

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export default async function MembersIndexPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (hasPermission(user, 'bookings')) redirect('/bookings')
  if (hasPermission(user, 'races')) redirect('/events')
  if (hasPermission(user, 'challenges')) redirect('/challenges')
  if (hasPermission(user, 'pulse_admin')) redirect('/pulse')
  if (hasPermission(user, 'studio_management')) redirect('/live')
  if (hasPermission(user, 'class_timer')) redirect('/studio-management/timer')
  if (hasPermission(user, 'approvals_hyrox_sessions')) redirect('/hyrox')
  redirect('/')
}
