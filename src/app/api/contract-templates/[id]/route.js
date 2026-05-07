// /api/contract-templates/[id]
//   GET     fetch one template (master/owner)
//   PATCH   update (master/owner)
//   DELETE  soft-delete (active=false). We don't hard-delete because
//           contracts.template_id has on delete restrict — issued
//           contracts must keep their template-row anchor for audit.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { contractTemplateSchema } from '@/lib/schemas'

export const runtime = 'nodejs'

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner'
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }
  const db = createServerClient()
  const { data, error } = await db
    .from('contract_templates')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data })
}

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  // Accept partial updates — re-use the schema with `.partial()` so
  // the wizard can patch a single field (toggle active, rename, etc.)
  // without resending the full body.
  const parsed = contractTemplateSchema.partial().safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  // Bump version when the body changes — preserves the audit trail
  // that the issued contracts were rendered against an older
  // template body. Toggle of active/name/description doesn't bump.
  const updates = { ...parsed.data }
  if (parsed.data.body_markdown !== undefined) {
    // We can't compute the new version atomically from the patch
    // payload without a SELECT first; do a tiny preflight read.
    const db = createServerClient()
    const { data: current } = await db
      .from('contract_templates')
      .select('version')
      .eq('id', params.id)
      .maybeSingle()
    updates.version = (current?.version || 1) + 1
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('contract_templates')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Master or owner only' }, { status: 403 })
  }
  // Soft-delete via active=false. Hard-delete would fail on the
  // FK (contracts.template_id on delete restrict) the moment a
  // template has been used. Soft-delete keeps issued contracts
  // intact while removing the template from the issue picker.
  const db = createServerClient()
  const { error } = await db
    .from('contract_templates')
    .update({ active: false })
    .eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
