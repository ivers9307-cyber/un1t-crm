// GET /api/admin/integrations         master-only list of provider rows
// PATCH /api/admin/integrations/[id]   update credentials / enabled flag

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

export async function GET() {
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const { data, error } = await db
    .from('service_integrations')
    .select('*')
    .order('display_name', { ascending: true })
  if (error) {
    logWarn('admin-integrations', 'list failed', { err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, integrations: data || [] })
}
