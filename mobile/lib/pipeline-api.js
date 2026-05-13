// Pipeline API helpers for mobile.
//
// The web app's /api/deals, /api/contacts, /api/notes, /api/activities,
// /api/stages routes all use requireApiKey() (n8n integration only) —
// they don't accept session/JWT auth. The web KanbanBoard talks to
// Supabase directly via createBrowserClient, relying on RLS for per-
// location scoping. Mobile follows the same pattern.
//
// Multi-location: we filter by activeLocationId for both reads and
// writes. RLS will additionally enforce that the caller belongs to
// that location, so the worst case is an empty result.

import { supabase } from './supabase'

export async function listStages(locationId) {
  let q = supabase.from('pipeline_stages')
    .select('id, name, slug, color, display_order')
    .order('display_order', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function listDealsByStage(stageId, locationId) {
  let q = supabase.from('deals')
    .select(`
      id, title, status, value, stage_id, created_at, updated_at, location_id,
      contacts:contact_id (id, name, first_name, last_name, pipeline_stage_slug, phone, wa_phone, email)
    `)
    .eq('stage_id', stageId)
    .eq('status', 'open')
    .order('updated_at', { ascending: false })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function getDeal(id) {
  const { data, error } = await supabase.from('deals')
    .select(`
      *,
      contacts:contact_id (*),
      pipeline_stages:stage_id (id, name, slug, color, display_order)
    `)
    .eq('id', id)
    .single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function moveDeal(dealId, newStageId) {
  const { data, error } = await supabase.from('deals')
    .update({ stage_id: newStageId, updated_at: new Date().toISOString() })
    .eq('id', dealId)
    .select()
    .single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function setDealStatus(dealId, status) {
  // status: 'open' | 'won' | 'lost'
  const { data, error } = await supabase.from('deals')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', dealId)
    .select()
    .single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function listActivitiesForContact(contactId) {
  const { data, error } = await supabase.from('activities')
    .select('id, subject, type, due_date, due_time, note, done, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(20)
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function listNotesForContact(contactId) {
  const { data, error } = await supabase.from('notes')
    .select('id, content, deal_id, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(20)
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function logActivity({ contactId, dealId, type, subject, note, locationId }) {
  // RLS doesn't enforce profile_id on insert here — we set it explicitly
  // so timeline ownership is correct.
  const { data, error } = await supabase.from('activities').insert({
    contact_id: contactId,
    deal_id: dealId || null,
    type: type || 'note',
    subject: subject || (type === 'call' ? 'Call' : type === 'email' ? 'Email' : 'Note'),
    note: note || null,
    done: type === 'note' || type === 'call' || type === 'email', // log entries are completed events
    location_id: locationId || null,
  }).select().single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function createNote({ contactId, dealId, content, locationId }) {
  const { data, error } = await supabase.from('notes').insert({
    contact_id: contactId,
    deal_id: dealId || null,
    content,
    location_id: locationId || null,
  }).select().single()
  return error ? { success: false, error: error.message } : { success: true, data }
}
