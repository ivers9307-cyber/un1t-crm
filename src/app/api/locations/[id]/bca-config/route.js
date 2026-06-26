// GET/PUT /api/locations/[id]/bca-config
//
// Read + write the per-location BCA Submit configuration (the JSONB
// stored in locations.bca_config — labels of the 10 doc slots, send-
// from + send-to email addresses, subject/body templates).
//
// Auth: any authenticated user at the location can READ (so the BCA
// tab on car detail can know which slots to render). Only `master`
// can WRITE — mirrors canEditLocationFeatures() because the email
// config affects every operator and could be used to silently
// redirect VAT-claim emails if compromised.
//
// PUT body shape: { send_from, send_to, subject_template,
//                   body_template, documents: [{slug,label}] x 10 }
// Validation lives in src/lib/bca.js validateBcaConfig() so the
// settings UI can use the same checker client-side for instant
// feedback.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { canEditLocationFeatures } from '@/lib/staff-access'
import { getBcaConfig, validateBcaConfig, isBcaSubmitEnabled } from '@/lib/bca'
import { validateBody } from '@/lib/validate'

// Permissive shape — domain validation is done by validateBcaConfig().
const BcaConfigSchema = z.object({
  send_from: z.string().optional(),
  send_to: z.string().optional(),
  subject_template: z.string().optional(),
  body_template: z.string().optional(),
  documents: z.array(z.any()).optional(),
}).passthrough()

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: location, error } = await db
    .from('locations')
    .select('id, slug, features, bca_config')
    .eq('id', params.id)
    .single()
  if (error || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, location.id)
  if (guard) return guard

  return NextResponse.json({
    success: true,
    data: {
      enabled: isBcaSubmitEnabled(location),
      // null when the feature is off; merged-with-defaults shape when on
      config: getBcaConfig(location),
    },
  })
}

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditLocationFeatures(user)) {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can edit BCA Submit configuration.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, BcaConfigSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const v = validateBcaConfig(body)
  if (!v.ok) {
    return NextResponse.json({ success: false, error: 'Validation failed', errors: v.errors }, { status: 400 })
  }

  const db = createServerClient()
  // Confirm location exists before writing so 404 distinguishes from
  // "validation rejected".
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, features')
    .eq('id', params.id)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  const { data, error } = await db
    .from('locations')
    .update({
      bca_config: v.value,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .select('id, features, bca_config')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({
    success: true,
    data: {
      enabled: isBcaSubmitEnabled(data),
      config: getBcaConfig(data),
    },
  })
}
