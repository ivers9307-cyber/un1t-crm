import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { createTemplate as createMetaTemplate, getTemplates as getMetaTemplates } from '@/lib/whatsapp'

// GET /api/whatsapp/templates — list templates (syncs with Meta)
export async function GET(request) {
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const sync = searchParams.get('sync')  // ?sync=true to refresh from Meta

  // If sync requested, fetch from Meta and update local records
  if (sync === 'true') {
    try {
      const metaTemplates = await getMetaTemplates()

      for (const mt of metaTemplates) {
        await db.from('whatsapp_templates')
          .upsert({
            meta_template_id: mt.id,
            name: mt.name,
            language: mt.language,
            category: mt.category,
            components: mt.components || [],
            status: mt.status,
            rejection_reason: mt.rejected_reason || null,
            location_id: locationId,
          }, { onConflict: 'meta_template_id' })
      }
    } catch (err) {
      console.error('Template sync error:', err)
    }
  }

  let query = db.from('whatsapp_templates')
    .select('*')
    .order('created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)

  const status = searchParams.get('status')
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, templates: data })
}

// POST /api/whatsapp/templates — create template and submit to Meta
export async function POST(request) {
  const db = createServerClient()
  const body = await request.json()

  try {
    // Submit to Meta
    const metaResult = await createMetaTemplate({
      name: body.name,
      category: body.category || 'MARKETING',
      language: body.language || 'en',
      components: body.components || [],
    })

    // Save locally with Meta's ID and status
    const { data, error } = await db.from('whatsapp_templates').insert({
      name: body.name,
      meta_template_id: metaResult.id,
      language: body.language || 'en',
      category: body.category || 'MARKETING',
      components: body.components || [],
      example_values: body.example_values || {},
      status: metaResult.status || 'PENDING',
      location_id: body.location_id,
      created_by: body.created_by,
    }).select().single()

    if (error) throw new Error(error.message)

    return NextResponse.json({ success: true, template: data })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
}
