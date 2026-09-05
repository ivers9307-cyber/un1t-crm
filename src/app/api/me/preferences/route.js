// /api/me/preferences — self-service preference updates.
//
// Distinct from /api/staff/[id] (which is admin-gated for full
// profile edits). This route only mutates user-personal preferences
// stored under profiles.permissions — anything an owner /
// manager /head_coach / staff member is allowed to change for
// themselves without needing admin approval.
//
// Currently supported keys:
//   - landing_preference: which dashboard /dashboard redirects to
//     ('auto' | 'personal' | 'studio' | 'business')
//     — stored inside profiles.permissions (JSONB)
//   - email_signature: the plain-text sign-off appended to this
//     person's ticket replies (EMAIL-TICKET.5, mig 493)
//     — stored as a profiles COLUMN, not in the JSONB
//
// Authorization model:
//   - Any authenticated user.
//   - Mutates ONLY their own row (profiles.id = user.id) — there's
//     no `id` parameter, the caller can't edit anyone else. That is
//     load-bearing for the signature in particular: this route runs on
//     the service-role client (no RLS), so "which row" is decided here
//     and nowhere else. A body-supplied id would let anyone rewrite
//     what a colleague's replies go out signed as.
//   - Permission validation is best-effort — if a user picks a
//     dashboard they don't have access to, we still store the
//     preference. The /dashboard redirect then falls through to the
//     smart-default chain. This avoids a confusing rejection in the
//     UI when an owner toggles their own dashboard_business off and
//     forgets they had it set as their landing.
//
// Returns: { success: true, data: { permissions } } so the caller
// can update its local state without a refetch.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { LANDING_PREFERENCE_VALUES } from '@shared/permissions'
import { MAX_SIGNATURE_LENGTH, normalizeSignature, MAX_SIGNATURE_LINKS, isAllowedSignaturePhotoUrl } from '@/lib/email-signature'
import { loadSignatureContexts, withEffectiveText } from '@/lib/signature-context'

export const runtime = 'nodejs'

const PreferencesSchema = z.object({
  landing_preference: z.enum(LANDING_PREFERENCE_VALUES).optional(),
  // Plain text, bounded by the same 2,000 chars as the mig 493 CHECK so a
  // long paste is a 400 here rather than a Postgres constraint violation.
  // Nullable so the editor can clear it back to "no signature".
  email_signature: z.string().max(MAX_SIGNATURE_LENGTH).nullable().optional(),
  // MAIL-SIG.1 — the structured rich signature. FIELDS, never markup: the
  // renderer escapes every value at send time, and the photo may only point
  // into our public branding bucket (checked HERE as well as at render, so a
  // rejected row never even exists). Nullable clears it.
  email_signature_rich: z.object({
    enabled: z.boolean(),
    name: z.string().max(120).optional().default(''),
    title: z.string().max(120).optional().default(''),
    phone: z.string().max(60).optional().default(''),
    note: z.string().max(200).optional().default(''),
    photo_url: z.string().url().max(500)
      // The RENDERER'S own normalized check (audit #1): one rule, two gates —
      // a dot-segment path that would normalize outside the branding bucket
      // is refused here exactly as the render would refuse to embed it.
      .refine(isAllowedSignaturePhotoUrl, 'Photo must be uploaded through the signature editor')
      .nullable().optional(),
    links: z.array(z.object({
      label: z.string().max(40),
      url: z.string().url().max(300).refine(u => /^https?:\/\//i.test(u), 'http(s) links only'),
    })).max(MAX_SIGNATURE_LINKS).optional().default([]),
  }).strict().nullable().optional(),
}).strict()

// GET /api/me/preferences — the caller's OWN preferences.
//
// Exists so a client surface can show what it is about to do on the user's
// behalf — the ticket composer renders the signature it is going to append.
// Same scoping as PATCH: profiles.id = user.id, no id parameter.
//
// MAILFIX-SIGTRUTH.1 also rides the caller's SIGNATURE CONTEXT along: one
// entry per location where they hold email_inbox (EVERY permitted studio —
// a send at a mailbox-less studio still resolves it), each flagged
// has_mailbox for the editor's chips, carrying BOTH halves of the truth:
//   • the INPUTS — studio name + the studio's own signature card, exactly
//     what the send routes feed effectiveRichSignature(). The web /account
//     preview and every composer's hint resolve over these CLIENT-SIDE (live
//     typing, From switching) with the same exported resolver the sends use;
//   • the RENDERED answer — effective_text / rich / has_photo / has_links,
//     resolved HERE through that same function. This is what mobile reads,
//     verbatim: it cannot import src/lib, so it must never resolve anything.
//     ('' + rich = an HTML-only block, no text part; null = nothing appends.)
// Best-effort by contract: a blipped context read degrades to nulls / an
// empty list and NEVER errors this GET — the send re-resolves for itself.
//
// MAIL-SIGDEFAULT.1 — the rendered half now carries the STUDIO block for a
// person who never opted in (rich NULL/disabled) wherever the studio has
// configured one, because that is what the send appends: the same
// resolveSendSignature the routes call. The wire SHAPE is unchanged, so the
// mobile hint (which renders effective_text verbatim) needs no change.
export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('profiles')
    .select('permissions, email_signature, email_signature_rich')
    .eq('id', user.id)
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // loadSignatureContexts never throws (it degrades internally), but the
  // belt matches the braces: nothing about the context may ever take this
  // GET down — the plain preferences half must survive any blip whole.
  let signatureContexts = []
  try {
    // Inputs from the estate, then the rendered answer per entry against
    // THIS profile row — the same `data` the plain fields above come from.
    signatureContexts = withEffectiveText(await loadSignatureContexts(db, user), data)
  } catch {
    signatureContexts = []
  }

  return NextResponse.json({
    success: true,
    data: {
      landing_preference: data?.permissions?.landing_preference || 'auto',
      email_signature: data?.email_signature || '',
      email_signature_rich: data?.email_signature_rich || null,
      // The studio the caller's session points at — the /account preview's
      // default. Null for a session with no active location; clients fall
      // back to the first context entry.
      active_location_id: user.activeLocation?.id || null,
      // [{ location_id, location_name, studio_signature, has_mailbox, ← inputs (web)
      //    effective_text, rich, has_photo, has_links }]             ← rendered (mobile)
      signature_contexts: signatureContexts,
    },
  })
}

export async function PATCH(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, PreferencesSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Build a minimal merge object — only set keys the caller actually
  // sent. Future preference keys plug in here.
  const patch = {}
  if (body.landing_preference !== undefined) {
    patch.landing_preference = body.landing_preference
  }

  // Column-level fields (not JSONB). Whitespace-only is stored as NULL,
  // not as a blank string, so "no signature" has exactly one
  // representation everywhere — the append helper treats them the same,
  // but a NULL is what the column comment describes.
  const columnPatch = {}
  if (body.email_signature !== undefined) {
    columnPatch.email_signature = normalizeSignature(body.email_signature) || null
  }
  if (body.email_signature_rich !== undefined) {
    columnPatch.email_signature_rich = body.email_signature_rich
  }

  if (Object.keys(patch).length === 0 && Object.keys(columnPatch).length === 0) {
    return NextResponse.json({ success: false, error: 'No preference fields to update' }, { status: 400 })
  }

  const db = createServerClient()

  // Read-modify-write of the JSONB. Single-user single-key edits
  // collide with themselves only — last write wins, acceptable for
  // a personal preference. The whole-blob update preserves any
  // admin-set keys (mobile.*, dashboard_*, etc.) untouched.
  //
  // Skipped entirely when the caller only touched a column field, so a
  // signature edit can't rewrite the permissions blob as a side effect.
  const update = { ...columnPatch }
  let merged = null
  if (Object.keys(patch).length > 0) {
    const { data: current, error: readErr } = await db
      .from('profiles')
      .select('permissions')
      .eq('id', user.id)
      .single()
    if (readErr) {
      return NextResponse.json({ success: false, error: readErr.message }, { status: 400 })
    }
    merged = { ...(current?.permissions || {}), ...patch }
    update.permissions = merged
  }

  const { error: writeErr } = await db
    .from('profiles')
    .update(update)
    // The ONLY row this route may touch. No id parameter exists, so a
    // caller cannot aim this at someone else's signature.
    .eq('id', user.id)
  if (writeErr) {
    return NextResponse.json({ success: false, error: writeErr.message }, { status: 400 })
  }

  return NextResponse.json({
    success: true,
    data: {
      ...(merged ? { permissions: merged } : {}),
      ...(body.email_signature !== undefined ? { email_signature: update.email_signature } : {}),
      ...(body.email_signature_rich !== undefined ? { email_signature_rich: update.email_signature_rich } : {}),
    },
  })
}
