import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

// POST /api/settings/branding/upload — Upload a logo or favicon image
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Only owners can upload branding' }, { status: 403 })
  }

  const formData = await request.formData()
  const file = formData.get('file')
  const type = formData.get('type') // 'logo' or 'favicon'
  const locationId = formData.get('location_id') || user.activeLocation?.id

  if (!file || !type) {
    return NextResponse.json({ success: false, error: 'file and type are required' }, { status: 400 })
  }

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  // Validate file type
  const allowedTypes = ['image/png', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/webp']
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json({ success: false, error: 'File must be PNG, SVG, WebP, or ICO' }, { status: 400 })
  }

  // Validate file size (5MB max)
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ success: false, error: 'File must be under 5MB' }, { status: 400 })
  }

  const db = createServerClient()

  // Build file path: branding/{location_id}/{type}.{ext}
  const ext = file.name.split('.').pop().toLowerCase()
  const filePath = `${locationId}/${type}.${ext}`

  // Upload to Supabase Storage (upsert to overwrite existing)
  const buffer = Buffer.from(await file.arrayBuffer())
  const { error: uploadError } = await db.storage
    .from('branding')
    .upload(filePath, buffer, {
      contentType: file.type,
      upsert: true,
    })

  if (uploadError) {
    return NextResponse.json({ success: false, error: uploadError.message }, { status: 400 })
  }

  // Get the public URL
  const { data: urlData } = db.storage.from('branding').getPublicUrl(filePath)
  const publicUrl = urlData.publicUrl + `?t=${Date.now()}` // cache-bust

  return NextResponse.json({ success: true, url: publicUrl })
}
