// GET /api/studio-management/ac/pods?api_key=xxx
//
// Operator-only helper for the location settings UI. Given a
// candidate Sensibo API key (typed in or already on the location),
// returns the list of pods on that account so the operator can
// pick the right one for THIS studio.
//
// Master + owner only — this is a setup tool, not a staff one.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { listPods, SensiboError } from '@/lib/sensibo'
import { overlayConnections } from '@/lib/connection-registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'master' && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Master or owner only.' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  let apiKey = searchParams.get('api_key')

  // If no key in query, fall back to the active location's stored
  // key — useful for "view current pods" without pasting again.
  if (!apiKey) {
    const locationId = user.activeLocation?.id
    if (locationId) {
      const db = createServerClient()
      const { data: locRow } = await db
        .from('locations')
        .select('id, sensibo_api_key')
        .eq('id', locationId)
        .single()
      // INTEG-A2 dual-read: registry `sensibo` row first.
      const loc = await overlayConnections(db, locRow, ['sensibo'])
      apiKey = loc?.sensibo_api_key || null
    }
  }
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'No API key supplied or saved on the active location.' },
      { status: 400 }
    )
  }

  try {
    const pods = await listPods(apiKey)
    return NextResponse.json({ success: true, data: pods })
  } catch (e) {
    const msg = e instanceof SensiboError ? e.message : (e?.message || String(e))
    const status = e instanceof SensiboError && e.status === 401 ? 401 : 502
    return NextResponse.json({ success: false, error: msg, code: 'sensibo_error' }, { status })
  }
}
