// PATCH /api/admin/integrations/[id]
// Master-only. Update client_id / client_secret / redirect_uri /
// scopes / is_enabled / notes. Provider + display_name are immutable
// after seed.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
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

const ALLOWED_FIELDS = ['client_id', 'client_secret', 'redirect_uri', 'scopes', 'is_enabled', 'notes']

// Masters only (profiles.role), no studio. A signed-in non-master keeps the
// old { ok: false, error: 'Forbidden' } 403; a signed-out call is withAuth's 401.
export const PATCH = withAuth({ permission: null, location: false }, async ({ request, user, db, params }) => {
  if (user.profileRole !== 'master') return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
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

  const { data, error } = await db
    .from('service_integrations')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()
  if (error) {
    logWarn('admin-integrations', 'update failed', { id, err: error })
    return NextResponse.json({ ok: false, error: 'Could not update the integration.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, integration: data })
})
