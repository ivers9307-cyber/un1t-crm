// GET /api/public/presentations/[token]/state — NO auth (token IS the auth).
// The viewer polls this ~1s; soft-swaps the slide when `version` changes.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bucketUrl(path) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/presentation-slides/${path}`
}

export async function GET(_request, { params }) {
  const { token } = await params
  if (!token) return NextResponse.json({ success: false, error: 'missing_token' }, { status: 400 })
  const db = createServerClient()
  const { data: deck } = await db
    .from('presentations')
    .select('id, title, current_index, version')
    .eq('view_token', token)
    .maybeSingle()
  if (!deck) return NextResponse.json({ success: false, error: 'invalid_token' }, { status: 404 })
  const { data: slides } = await db
    .from('presentation_slides')
    .select('image_path')
    .eq('presentation_id', deck.id)
    .order('position', { ascending: true })
  return NextResponse.json({
    success: true,
    title: deck.title,
    current_index: deck.current_index,
    version: deck.version,
    slides: (slides || []).map((s) => bucketUrl(s.image_path)),
  })
}
