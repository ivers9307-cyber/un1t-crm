// MEMBERWRITESWEEP.1f — the OLD direct path for the phone's TV screen, kept
// ONLY as a fallback for an older server.
//
// mobile/lib/tv-api.js now acts through the session routes
// (/api/admin/tv-displays*, /api/admin/tv-templates*). An OTA can reach a
// phone before the web deploy that adds those routes (or after a deploy is
// rolled back); the server then answers an HTML 404, which api() turns into
// its transport envelope with status 404 (routeNotDeployed in tv-api.js).
// Only then do these run: the pre-1f reads and writes on tv_displays,
// tv_content and tv_templates, verbatim, so the screen behaves as it did.
//
// 🔴 DELETE THIS FILE IN 1g (mig 685). Once 685 closes the tables to client
// sessions these calls can only fail (42501), and the routes are deployed by
// then (685 applies only after 1f's deploy and OTA). The 1g guard rows fail
// any `.from('tv_*')` left in mobile/.

import { supabase } from './supabase'

export async function listTvDisplays(locationId) {
  const { data: displays, error } = await supabase
    .from('tv_displays')
    .select('id, label, token, active, rotation, location_id, created_at')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
  if (error) return { success: false, error: error.message }
  const rows = displays || []
  if (rows.length === 0) return { success: true, data: [] }

  const ids = rows.map((d) => d.id)
  const { data: contents } = await supabase
    .from('tv_content')
    .select('tv_display_id, source_type, source_ref, label, template_values, pushed_at')
    .in('tv_display_id', ids)
  const byDisplay = new Map((contents || []).map((c) => [c.tv_display_id, c]))

  return {
    success: true,
    data: rows.map((d) => ({ ...d, content: byDisplay.get(d.id) || null })),
  }
}

export async function clearTvContent(tvDisplayId) {
  const { error } = await supabase
    .from('tv_content')
    .delete()
    .eq('tv_display_id', tvDisplayId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function registerTvDisplay(locationId, label) {
  const { error } = await supabase
    .from('tv_displays')
    .insert({ location_id: locationId, label })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function deleteTvDisplay(id) {
  const { error } = await supabase.from('tv_displays').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function setTvRotation(id, rotation) {
  const { error } = await supabase.from('tv_displays').update({ rotation }).eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function listTvTemplates(locationId) {
  const { data, error } = await supabase
    .from('tv_templates')
    .select('id, name, base_image_path, zones')
    .eq('location_id', locationId)
    .order('name', { ascending: true })
  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

export async function pushTvContent(tvDisplayId, { source_type, source_ref, label, template_values } = {}, pushedBy) {
  const { error } = await supabase.from('tv_content').upsert({
    tv_display_id: tvDisplayId,
    source_type,
    source_ref,
    label: label || null,
    template_values: template_values ?? null,
    pushed_at: new Date().toISOString(),
    pushed_by: pushedBy || null,
    triggered_by: pushedBy ? `manual:${pushedBy}` : 'manual',
  }, { onConflict: 'tv_display_id' })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function getTvTemplate(id) {
  const { data, error } = await supabase
    .from('tv_templates')
    .select('id, name, base_image_path, zones, location_id')
    .eq('id', id)
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, data }
}

export async function saveTvTemplate({ id, locationId, name, base_image_path, zones, createdBy }) {
  if (id) {
    const { error } = await supabase
      .from('tv_templates')
      .update({ name, base_image_path, zones, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return { success: false, error: error.message }
    return { success: true, id }
  }
  const { data, error } = await supabase
    .from('tv_templates')
    .insert({ location_id: locationId, name, base_image_path, zones, created_by: createdBy || null })
    .select('id')
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, id: data?.id }
}

export async function deleteTvTemplate(id) {
  const { error } = await supabase.from('tv_templates').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
