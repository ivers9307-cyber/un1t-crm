// POST /api/admin/policies/[slug]/versions — publish a NEW version
// of a policy. Master/owner only. Atomically (via the partial-unique
// index race-safety) flips the previous current to false and inserts
// the new version with is_current = true.
//
// On success, returns { version: { id, version_number, effective_date } }.
//
// Body shape:
//   { body_markdown: string (1..200000),
//     change_summary?: string (<=2000),
//     effective_date: ISO date (YYYY-MM-DD) }

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { publishVersion } from '@/lib/policies'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'

const PublishSchema = z.object({
  body_markdown: z.string().min(1).max(200_000),
  change_summary: z.string().max(2000).nullable().optional(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

function isOwnerOrMaster(user) {
  return user?.role === 'master' || user?.role === 'owner' || user?.profileRole === 'master'
}

export async function POST(request, { params }) {
  const { slug } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOwnerOrMaster(user)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, PublishSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: policy } = await db
    .from('policies')
    .select('id, active')
    .eq('slug', slug)
    .maybeSingle()
  if (!policy || !policy.active) {
    return NextResponse.json({ success: false, error: 'Policy not found' }, { status: 404 })
  }

  try {
    const version = await publishVersion({
      policyId: policy.id,
      bodyMarkdown: body.body_markdown,
      changeSummary: body.change_summary || null,
      effectiveDate: body.effective_date,
      publishedBy: user.id,
    })

    // AUDIT-EXPAND.1 — policy versioning is high-stakes (it's the
    // employment-handbook source of truth + view-tracking baseline)
    // so every published version is logged. target_resource uses
    // the slug so an admin reading the log can click straight to
    // /policies/<slug>.
    await logAuditEvent({
      category: 'business',
      action: 'policy.published',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: {
        id: null,
        label: slug,
        resource: `policies/${slug}`,
      },
      details: {
        policy_id: policy.id,
        version_id: version?.id || null,
        version_number: version?.version_number || null,
        change_summary: body.change_summary || null,
        effective_date: body.effective_date,
      },
      request,
    })

    return NextResponse.json({ success: true, version })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'Publish failed' }, { status: 500 })
  }
}
