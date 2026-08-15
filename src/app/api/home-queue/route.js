// GET /api/home-queue — HOME.3, the needs-attention triage queue.
//
// One assembled list over approvals + email tickets + the unified
// WhatsApp/Instagram inbox — see src/lib/home-queue.js for the gating,
// merge/sort and cap rules; this route is just auth + envelope.
//
// No single `permission` gates this surface — each of the three sources
// self-gates exactly as its own count query does (approvals via the
// registry's per-provider isVisible/permissionKey, tickets via
// hasPermissionForLocation('email_inbox') + mailbox visibility, inbox via
// hasPermission('whatsapp')) — so withAuth is used auth-only here, the same
// shape /api/approvals/pending uses with a direct getCurrentUser() call.
// `location: false` because "no active location" is a valid, well-defined
// state (assembleHomeQueue answers all-empty for it), not a 400.
//
// assembleHomeQueue never throws — a failed source degrades to an empty
// bucket via Promise.allSettled (see its header) — so the only 500 this
// route can produce is the one it raises itself, and only when EVERY
// source degraded: a caller who asked for their queue and got told
// "everything failed" deserves that signal, but one flaky source among
// three must not blank a surface the other two are still answering for.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { assembleHomeQueue } from '@/lib/home-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: null, location: false },
  async ({ user, db }) => {
    const data = await assembleHomeQueue(db, user)
    if (data.degraded && data.degraded.length >= 3) {
      return NextResponse.json({
        success: false,
        error: 'Could not load the needs-attention queue — every source failed. Try again.',
        data,
      }, { status: 500 })
    }
    return NextResponse.json({ success: true, data })
  }
)
