import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createTemplate as createMetaTemplate, getTemplates as getMetaTemplates } from '@/lib/whatsapp'
import { getCurrentUser, assertLocationAccess, assertLocationAccessOr404, getUserLocationIds } from '@/lib/auth'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { componentsButtonsError } from '@/lib/whatsapp-template-buttons'
import { ownNumberOrRefusal, NUMBER_LOOKUP_FAILED_MESSAGE } from '@/lib/whatsapp-own-number'
import { templateLocationIdFor, listLocationNumberConfigs } from '@/lib/whatsapp-config'
import { planTemplateSync } from '@/lib/whatsapp-template-sync'
import { NO_WHATSAPP_NUMBER_MESSAGE, NO_LOCATION_MESSAGE } from '@/lib/whatsapp-number-missing'
import { logError } from '@/lib/log'

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
  // The picker inside a thread asks by conversation: it lists the thread's
  // studio's templates (templateLocationIdFor; WAORGNUMBER.6 removed the
  // sibling case). Authorised on the CONVERSATION's studio, so staff of that
  // studio need no access to the active one; cached rows only, never a sync.
  const conversationId = searchParams.get('conversation_id')
  if (conversationId) {
    const db = createServerClient()
    const { data: conv, error: convErr } = await db.from('whatsapp_conversations')
      .select('id, location_id').eq('id', conversationId).maybeSingle()
    if (convErr) return NextResponse.json({ success: false, error: 'Could not load the conversation' }, { status: 500 })
    if (!conv) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    // 404 like the unknown id above: a 403 here would confirm the id exists.
    const convGuard = assertLocationAccessOr404(user, conv.location_id)
    if (convGuard) return convGuard
    const templateLocationId = await templateLocationIdFor(conv.location_id, conv.id)
    // Same select and order as the location mode below: one row shape.
    let q = db.from('whatsapp_templates').select('*').order('created_at', { ascending: false })
      .eq('location_id', templateLocationId)
    const status = searchParams.get('status')
    if (status) q = q.eq('status', status)
    const { data: templates, error } = await q
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, templates: templates || [], template_location_id: templateLocationId })
  }

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
      syncError = await syncTemplatesFromMeta(db, locationId)
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

// Every whatsapp_templates row on one WABA, any studio (the sync planner's
// rowsOnWaba), paged under the 1,000-row cap. Throws on a failed read.
const ROWS_PAGE = 1000
async function templateRowsOnWaba(db, wabaId) {
  const rows = []
  for (let from = 0; ; from += ROWS_PAGE) {
    const { data, error } = await db.from('whatsapp_templates')
      .select('id, name, language, location_id, meta_template_id')
      .eq('business_account_id', wabaId)
      .order('id', { ascending: true })
      .range(from, from + ROWS_PAGE - 1)
    if (error) throw new Error(`Could not read the saved templates: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < ROWS_PAGE) return rows
  }
}

// WAORGNUMBER.2 (R5) — "Sync at studio S". For each distinct WABA among the
// numbers switched on at S (default first, so Meta is read with the default's
// token where it is on that WABA): fetch EVERY page of Meta's templates, plan
// against every row on that WABA at any studio (planTemplateSync), and write.
// S's own rows are updated; a template another studio owns is skipped; a
// template no studio owns is adopted only when S is the home studio of one of
// its numbers on that WABA. So syncing at Hatch never copies Stillorgan's
// templates into Hatch, and a template made in Meta's UI appears at the
// number's home studio. Returns the sync_error (null = clean); one WABA's
// failure does not stop the others.
//
// WACONFIGFALLBACK.1 — its OWN switched-on numbers only: resolving by location
// id once fell back to the global env number at a studio with none, copying
// another studio's templates into its rows. No number (or no location) →
// sync_error, Meta never called, the cache is still served.
async function syncTemplatesFromMeta(db, locationId) {
  if (!locationId) return NO_LOCATION_MESSAGE
  let numbers
  try {
    numbers = await listLocationNumberConfigs(locationId)
  } catch (e) {
    logError('wa-templates-sync', 'number lookup failed', { locationId, err: e?.message })
    return NUMBER_LOOKUP_FAILED_MESSAGE
  }
  if (numbers.length === 0) return NO_WHATSAPP_NUMBER_MESSAGE

  const byWaba = new Map() // wabaId → { config (first in studio order), isHomeStudio }
  for (const n of numbers) {
    if (!n.businessAccountId) continue
    const entry = byWaba.get(n.businessAccountId) || { config: n, isHomeStudio: false }
    if (n.homeLocationId === locationId) entry.isHomeStudio = true
    byWaba.set(n.businessAccountId, entry)
  }
  if (byWaba.size === 0) return 'WhatsApp Business Account ID is not configured for this number.'

  const problems = []
  for (const [wabaId, { config, isHomeStudio }] of byWaba) {
    try {
      const metaTemplates = await getMetaTemplates(100, { config, all: true })
      const rowsOnWaba = await templateRowsOnWaba(db, wabaId)
      // A row of THIS studio saved before its WABA was recorded is matched by
      // Meta's id only (globally unique) and stamped with the WABA here.
      const metaIds = new Set(metaTemplates.map((mt) => mt.id).filter(Boolean).map(String))
      const { data: unstamped, error: unstampedErr } = await db.from('whatsapp_templates')
        .select('id, name, language, location_id, meta_template_id')
        .eq('location_id', locationId)
        .is('business_account_id', null)
      if (unstampedErr) throw new Error(`Could not read the saved templates: ${unstampedErr.message}`)
      for (const r of unstamped || []) if (r.meta_template_id && metaIds.has(String(r.meta_template_id))) rowsOnWaba.push(r)

      const plan = planTemplateSync({ metaTemplates, rowsOnWaba, studioId: locationId, isHomeStudio, wabaId })
      let failed = 0
      // supabase-js REPORTS a failed write on `error`, it does not throw, so each
      // write is judged: unchecked, a sync that persisted nothing still returned
      // a clean result over top of the stale rows.
      for (const u of plan.updates) {
        const { error } = await db.from('whatsapp_templates').update(u.row).eq('id', u.id)
        if (error) failed++
      }
      for (const row of plan.inserts) {
        const { error } = await db.from('whatsapp_templates').insert(row)
        if (error) failed++
      }
      if (failed > 0) {
        problems.push(`Refreshed from Meta, but ${failed} of ${plan.updates.length + plan.inserts.length} templates could not be saved.`)
      }
    } catch (err) {
      logError('wa-templates-sync', 'sync failed for one account', { locationId, wabaId, err: err?.message })
      problems.push(err?.message || 'Could not refresh templates from Meta.')
    }
  }
  return problems.length ? problems.join(' ') : null
}

// POST /api/whatsapp/templates — create template and submit to Meta. MANAGER_ROLES
// and `whatsapp` at the location created at, the resubmit rule (WATPLROLE.1,
// GATES-3).
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, WaTemplateCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  // WATPLROLE.1 — membership alone let any staff member submit a template to
  // Meta under the studio's name. Same rule as resubmit: MANAGER_ROLES AT the
  // location created at (never the active studio's role). No location at all
  // fails closed here instead of creating a row with none.
  // GATES-3 (b) — and the `whatsapp` permission there (canManageWaTemplatesAt).
  if (!canManageWaTemplatesAt(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Meta refuses a malformed button with a generic code-100 "Invalid parameter"
  // that names neither the button nor the rule. Fail here instead, with both.
  const buttonError = componentsButtonsError(body.components)
  if (buttonError) return NextResponse.json({ success: false, error: buttonError }, { status: 400 })

  // WACONFIGFALLBACK.1 — submit on THIS location's own WABA. The create was
  // called with no location at all, so every template went to the global env
  // number's WABA whatever location it was saved under. No number → 409 and
  // Meta is never called; a failed lookup → 500.
  const own = await ownNumberOrRefusal(locationId, 'wa-templates-create')
  if (!own.ok) return NextResponse.json({ success: false, error: own.error }, { status: own.status })

  const db = createServerClient()

  // WAORGNUMBER.2 (R5) — the template goes on the WABA of the studio's default
  // number, which other studios may share. A name another studio already uses
  // on that account (or this studio in this language) is refused before Meta,
  // naming the owner: Meta would merge a second studio's template into the
  // owner's under one name.
  const wabaId = own.config.businessAccountId || null
  const language = body.language || 'en'
  if (wabaId) {
    // `locations!location_id`: whatsapp_template_events, whatsapp_broadcasts
    // and event_types each hold FKs to both tables, so a bare `locations` embed
    // is ambiguous and PostgREST answers 300 (PGRST201), failing every create.
    const { data: clashes, error: clashErr } = await db.from('whatsapp_templates')
      .select('location_id, language, locations!location_id ( name )')
      .eq('business_account_id', wabaId)
      .eq('name', body.name)
    if (clashErr) {
      logError('wa-templates-create', 'name check failed', { locationId, err: clashErr.message })
      return NextResponse.json({ success: false, error: 'Could not check that template name just now. Try again.' }, { status: 500 })
    }
    const clash = (clashes || []).find((r) => r.location_id !== locationId || r.language === language)
    if (clash) {
      const owner = clash.locations?.name || 'another studio'
      return NextResponse.json({
        success: false,
        error: `That name is already used by ${owner} on this WhatsApp account. Pick another name.`,
      }, { status: 409 })
    }
  }

  try {
    // Submit to Meta
    const metaResult = await createMetaTemplate({
      name: body.name,
      category: body.category || 'MARKETING',
      language,
      components: body.components || [],
      parameterFormat: body.parameter_format,
    }, { config: own.config })

    // Save locally with Meta's ID and status
    const { data, error } = await db.from('whatsapp_templates').insert({
      name: body.name,
      meta_template_id: metaResult.id,
      language,
      category: body.category || 'MARKETING',
      components: body.components || [],
      example_values: body.example_values || {},
      status: metaResult.status || 'PENDING',
      location_id: locationId,
      business_account_id: wabaId,
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
