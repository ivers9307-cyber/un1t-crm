// POST / DELETE /api/wearables/apple-health/connect
//
// Customer-authed (member Supabase JWT). Records (POST) or revokes (DELETE) the
// member's Apple Health connection in hr_provider_connections. With direct
// HealthKit there is no server to sign into — this row only tracks consent +
// connected-state (so the app + any future logic know the member is on Apple
// Health). access_token is NOT NULL on the table, so we store a sentinel.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROVIDER = 'apple_health'
// No OW/server token in the direct model; access_token is NOT NULL → sentinel.
const DIRECT_TOKEN_SENTINEL = 'direct-healthkit'

export async function POST(request) {
  const db = createServerClient()
  const { contact, error } = await resolveCustomerContact(request, { db })
  if (error) {
    return NextResponse.json({ success: false, error }, { status: error === 'no_contact' ? 409 : 401 })
  }

  const { error: upsertErr } = await db.from('hr_provider_connections').upsert({
    contact_id: contact.id,
    provider: PROVIDER,
    provider_user_id: contact.id, // presence marker — no OW user id anymore
    access_token: DIRECT_TOKEN_SENTINEL,
    refresh_token: null,
    token_expires_at: null,
    status: 'active',
    last_error: null,
  }, { onConflict: 'contact_id,provider' })
  if (upsertErr) {
    console.warn(`[apple-health-connect] upsert failed for contact ${contact.id}: ${upsertErr.message}`)
    return NextResponse.json({ success: false, error: 'persist_failed' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}

export async function DELETE(request) {
  const db = createServerClient()
  const { contact, error } = await resolveCustomerContact(request, { db })
  if (error) {
    return NextResponse.json({ success: false, error }, { status: error === 'no_contact' ? 409 : 401 })
  }

  const { error: updErr } = await db
    .from('hr_provider_connections')
    .update({ status: 'revoked', last_error: null })
    .eq('contact_id', contact.id)
    .eq('provider', PROVIDER)
  if (updErr) {
    console.warn(`[apple-health-connect] revoke failed for contact ${contact.id}: ${updErr.message}`)
    return NextResponse.json({ success: false, error: 'revoke_failed' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
