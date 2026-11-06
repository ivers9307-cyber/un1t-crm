// PIPEBUILD.4a — submit a WhatsApp template to Meta and save the row. Lifted out
// of POST /api/whatsapp/templates so the recipe installer can submit from a
// library; the route keeps auth, permission and body validation and maps this
// result to its responses. Every failure it can name is a result (a bad
// button, no number, a failed number lookup, a name clash, Meta's refusal, a
// failed save). It does NOT catch a throw from the supabase client or the
// button checker, so it can still throw: a library caller wraps it (the
// recipe installer does).
import { createTemplate as createMetaTemplate } from '@/lib/whatsapp'
import { componentsButtonsError } from '@/lib/whatsapp-template-buttons'
import { ownNumberOrRefusal } from '@/lib/whatsapp-own-number'
import { logError } from '@/lib/log'

export async function submitWhatsappTemplate(db, {
  locationId,
  name,
  category = 'MARKETING',
  language = 'en',
  components = [],
  createdBy = null,
  parameterFormat,
  exampleValues,
  headerMediaHandle,
  headerMediaUrl,
  headerMediaPath,
  displayGroup,
}) {
  // Meta refuses a malformed button with a generic code-100 "Invalid parameter"
  // that names neither the button nor the rule. Fail here instead, with both.
  const buttonError = componentsButtonsError(components)
  if (buttonError) return { ok: false, status: 400, error: buttonError }

  // WACONFIGFALLBACK.1 — submit on THIS location's own WABA. No number → 409
  // and Meta is never called; a failed lookup → 500.
  const own = await ownNumberOrRefusal(locationId, 'wa-templates-create')
  if (!own.ok) return { ok: false, status: own.status, error: own.error }

  // WAORGNUMBER.2 (R5) — a name another studio already uses on this WABA (or
  // this studio in this language) is refused before Meta, naming the owner.
  const wabaId = own.config.businessAccountId || null
  if (wabaId) {
    // `locations!location_id`: whatsapp_template_events, whatsapp_broadcasts
    // and event_types each hold FKs to both tables, so a bare `locations` embed
    // is ambiguous and PostgREST answers 300 (PGRST201), failing every create.
    const { data: clashes, error: clashErr } = await db.from('whatsapp_templates')
      .select('id, location_id, language, locations!location_id ( name )')
      .eq('business_account_id', wabaId)
      .eq('name', name)
    if (clashErr) {
      logError('wa-templates-create', 'name check failed', { locationId, err: clashErr.message })
      return { ok: false, status: 500, error: 'Could not check that template name just now. Try again.' }
    }
    const clash = (clashes || []).find((r) => r.location_id !== locationId || r.language === language)
    if (clash) {
      const owner = clash.locations?.name || 'another studio'
      const result = {
        ok: false,
        status: 409,
        code: 'name_clash',
        error: `That name is already used by ${owner} on this WhatsApp account. Pick another name.`,
      }
      // A reinstall: the clashing row is this studio's own, same language.
      if (clash.location_id === locationId && clash.language === language) result.existing = { id: clash.id }
      return result
    }
  }

  let metaResult
  try {
    metaResult = await createMetaTemplate({ name, category, language, components, parameterFormat }, { config: own.config })
  } catch (err) {
    return { ok: false, status: 400, error: err.message }
  }

  try {
    const { data, error } = await db.from('whatsapp_templates').insert({
      name,
      meta_template_id: metaResult.id,
      language,
      category,
      components,
      example_values: exampleValues || {},
      status: metaResult.status || 'PENDING',
      location_id: locationId,
      business_account_id: wabaId,
      created_by: createdBy,
      header_media_handle: headerMediaHandle || null,
      header_media_url: headerMediaUrl || null,
      header_media_path: headerMediaPath || null,
      display_group: displayGroup?.trim() || null,
    }).select().single()
    if (error) throw new Error(error.message)
    return { ok: true, template: data }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      code: 'orphan_at_meta',
      error: `The template was submitted to Meta but could not be saved here (${err.message}). It exists at Meta; a re-sync will adopt it.`,
    }
  }
}
