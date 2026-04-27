import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/contacts/search?term=email@example.com&fields=email
// Replaces Pipedrive GET /v1/persons/search
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { searchParams } = new URL(request.url)
  const term = searchParams.get('term') || ''
  const fields = searchParams.get('fields') || 'email'
  const limit = parseInt(searchParams.get('limit') || '10')
  const db = createServerClient()

  let query = db.from('contacts').select('*')

  if (fields === 'email') {
    query = query.ilike('email', `%${term}%`)
  } else {
    query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
  }

  const { data, error } = await query.limit(limit)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Match Pipedrive's response shape so n8n code nodes need minimal changes
  return NextResponse.json({
    success: true,
    data: {
      items: (data || []).map(item => ({ item }))
    }
  })
}
