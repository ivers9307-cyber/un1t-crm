import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/stages — List all pipeline stages
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data, error } = await db.from('pipeline_stages').select('*').order('display_order')

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
