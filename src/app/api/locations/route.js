import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/locations — List all active locations
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data, error } = await db
    .from('locations')
    .select('id, name, slug, address, active, timezone')
    .eq('active', true)
    .order('name')

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
