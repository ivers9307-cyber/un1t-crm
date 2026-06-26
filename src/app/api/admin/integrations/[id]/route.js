// PATCH /api/admin/integrations/[id]
// Master-only. Update client_id / client_secret / redirect_uri /
// scopes / is_enabled / notes. Provider + display_name are immutable
// after seed.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'

// All fields optional — the route itself validates "at least one present"
const IntegrationPatchSchema = z.object({
  client_id:     z.string().optional(),
  client_secret: z.string().optional(),
  redirect_uri:  z.string().optional(),
  scopes:        z.array(z.string()).optional(),
  is_enabled:    z.boolean().optional(),
  notes:         z.string().optional(),
}).passthrough()

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

const ALLOWED_FIELDS = ['client_id', 'client_secret', 'redirect_uri', 'scopes', 'is_enabled', 'notes']

export async function PATCH(request, props) {
  const params = await props.params;
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
  const id = params?.id
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 })

  const v = await validateBody(request, IntegrationPatchSchema)
  if (!v.ok) return v.response
  const body = v.data

  const patch = {}
  for (const k of ALLOWED_FIELDS) {
    if (body[k] === undefined) continue
    if (k === 'is_enabled')   patch[k] = Boolean(body[k])
    else if (k === 'scopes')  patch[k] = Array.isArray(body[k]) ? body[k] : []
    else                      patch[k] = body[k] === '' ? null : String(body[k])
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: 'No valid fields to update' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('service_integrations')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()
  if (error) {
    logWarn('admin-integrations', 'update failed', { id, err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, integration: data })
}
