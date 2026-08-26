import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createTemplate as createMetaTemplate, getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { componentsButtonsError } from '@/lib/whatsapp-template-buttons'

const WaTemplateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  language: z.string().max(20).optional(),
  components: z.array(z.unknown()),
  // NAMED = {{first_name}}-style params (Meta stores the format; the synced
  // components carry the named examples — no local column needed).
  parameter_format: z.enum(['POSITIONAL', 'NAMED']).optional(),
  example_values: z.unknown().optional(),
  location_id: uuidLike.optional(),
  // Media-header upload metadata (mig 045). header_handle goes into
  // the components.example.header_handle for approval; header_url is
  // the public URL the messaging API fetches at send time.
  // Meta's resumable-upload handles are opaque and can exceed 500 chars
  // for VIDEO assets (bit a real template 2026-06-11) — the DB column is
  // TEXT, so this is just a sanity bound. Keep it generous.
  header_media_handle: z.string().max(4000).nullable().optional(),
  header_media_url: z.string().url().max(2000).nullable().optional(),
  header_media_path: z.string().max(500).nullable().optional(),
  // Operator-defined picker grouping (mig 450) — local-only, never sent
  // to Meta and untouched by ?sync=true.
  display_group: z.string().max(100).nullable().optional(),
})

// GET /api/whatsapp/templates — list templates (syncs with Meta)
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const sync = searchParams.get('sync')  // ?sync=true to refresh from Meta

  // The cached rows below are served whether or not the refresh worked, so this
  // field is the ONLY thing that tells an operator they are reading stale data.
  // Swallowing it is how `book_first_visit` showed a months-old body and button
  // config in the send preview while the approved template said otherwise
  // (found 2026-08-26). Null = the refresh actually succeeded.
  let syncError = null

  // If sync requested, fetch from Meta and update local records
  if (sync === 'true') {
    try {
      // Fetch from THIS location's WABA (passing locationId) — not the env-default
      // WABA — or a Meta-Manager-created template for this number is never seen.
      const metaTemplates = await getMetaTemplates(100, { locationId })

      let failed = 0
      for (const mt of metaTemplates) {
        const row = {
          meta_template_id: mt.id,
          name: mt.name,
          language: mt.language,
          category: mt.category,
          components: mt.components || [],
          status: mt.status,
          rejection_reason: mt.rejected_reason || null,
          location_id: locationId,
        }
        // Manual upsert keyed on (meta_template_id, location_id): there is NO unique
        // constraint on meta_template_id, so a PostgREST `onConflict` upsert throws
        // 42P10 and the whole sync was silently swallowed by the catch below.
        const { data: existing, error: findError } = await db.from('whatsapp_templates')
          .select('id').eq('meta_template_id', mt.id).eq('location_id', locationId).maybeSingle()
        if (findError) { failed++; continue }
        // supabase-js REPORTS a failed write on `error`, it does not throw — so the
        // catch below never sees one. Unchecked, a sync that persisted nothing at
        // all still returned a clean result over top of the stale rows.
        const { error: writeError } = existing
          ? await db.from('whatsapp_templates').update(row).eq('id', existing.id)
          : await db.from('whatsapp_templates').insert(row)
        if (writeError) failed++
      }

      if (failed > 0) {
        syncError = `Refreshed from Meta, but ${failed} of ${metaTemplates.length} templates could not be saved.`
      }
    } catch (err) {
      console.error('Template sync error:', err)
      syncError = err?.message || 'Could not refresh templates from Meta.'
    }
  }

  // Present only when a refresh was actually asked for, so a caller that did not
  // request one can't mistake an absent key for a clean sync. null = it worked.
  const syncField = sync === 'true' ? { sync_error: syncError } : {}

  let query = db.from('whatsapp_templates')
    .select('*')
    .order('created_at', { ascending: false })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, templates: [], ...syncField })
    query = query.in('location_id', userLocationIds)
  }

  const status = searchParams.get('status')
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, templates: data, ...syncField })
}

// POST /api/whatsapp/templates — create template and submit to Meta
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, WaTemplateCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  // Meta refuses a malformed button with a generic code-100 "Invalid parameter"
  // that names neither the button nor the rule. Fail here instead, with both.
  const buttonError = componentsButtonsError(body.components)
  if (buttonError) return NextResponse.json({ success: false, error: buttonError }, { status: 400 })

  const db = createServerClient()

  try {
    // Submit to Meta
    const metaResult = await createMetaTemplate({
      name: body.name,
      category: body.category || 'MARKETING',
      language: body.language || 'en',
      components: body.components || [],
      parameterFormat: body.parameter_format,
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
      location_id: locationId,
      created_by: user.id,
      header_media_handle: body.header_media_handle || null,
      header_media_url: body.header_media_url || null,
      header_media_path: body.header_media_path || null,
      display_group: body.display_group?.trim() || null,
    }).select().single()

    if (error) throw new Error(error.message)

    return NextResponse.json({ success: true, template: data })
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 })
  }
}
