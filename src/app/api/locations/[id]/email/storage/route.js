// EMAIL-ATTACH.1 — the operator's view of mailbox storage, and the way down.
//
// GET  /api/locations/[id]/email/storage
//   Per-mailbox fill against the 5 GB ceiling, plus the location's UNFILED
//   bucket when it holds anything.
//
// POST /api/locations/[id]/email/storage
//   { action: 'prune',       mailbox_id, older_than_days }  → reclaim space
//   { action: 'recalculate' }                               → repair drift
//
// SAME GATE AS THE MAILBOX ADMIN SURFACE, for the same reason: a manager holds
// `email_inbox` and is NOT elevated. Storage figures are one thing, but prune
// DESTROYS a member's correspondence attachments, so it belongs to whoever may
// manage the accounts themselves — master or owner at this location.
// guardMailboxAdmin is that definition, already used by the sibling routes.
//
// WHY THE UNFILED BUCKET EXISTS AT ALL
// email_tickets.mailbox_id is ON DELETE SET NULL, so a deleted mailbox orphans
// its correspondence rather than destroying it — and mig 496 mirrors that on
// the attachment. Those bytes still occupy the bucket and still cost money, so
// they get their own counter row (mailbox_id NULL) with the same ceiling, and
// they are prunable. Metering them nowhere would let a deleted mailbox be a
// quota bypass; crashing on them would take an operator screen down over a
// state the schema explicitly permits.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logAuditEvent } from '@/lib/audit'
import { uuidLike } from '@/lib/schemas'
import { MAILBOX_LIMIT, guardMailboxAdmin, mailboxUnauthorized } from '../mailboxes/_helpers'
import { EMAIL_MAILBOX_QUOTA_BYTES, quotaStatus } from '@/lib/email-attachment-quota'
import {
  PRUNE_BATCH_LIMIT,
  pruneMailboxAttachments,
  recalcStorageUsage,
} from '@/lib/email-attachments-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A studio runs a handful of accounts, but every .select() caps at 1,000 rows
// whatever the caller asks for, so the bound is stated.
const USAGE_LIMIT = 200

/** Shape one counter row (or the absence of one) for the UI. */
function usageEntry({ mailbox, row }) {
  const quota = Number(row?.quota_bytes) || EMAIL_MAILBOX_QUOTA_BYTES
  const used = Number(row?.bytes_used) || 0
  return {
    mailbox_id: mailbox?.id ?? null,
    label: mailbox?.label ?? null,
    address: mailbox?.address ?? null,
    active: mailbox?.active ?? null,
    bytes_used: used,
    quota_bytes: quota,
    ...quotaStatus(used, quota),
  }
}

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const db = createServerClient()

  const [{ data: mailboxes, error: mbErr }, { data: usage, error: usageErr }] = await Promise.all([
    db.from('email_mailboxes')
      .select('id, label, address, active')
      .eq('location_id', params.id)
      .limit(MAILBOX_LIMIT),
    db.from('email_storage_usage')
      .select('mailbox_id, bytes_used, quota_bytes, updated_at')
      .eq('location_id', params.id)
      .limit(USAGE_LIMIT),
  ])
  // FAIL LOUDLY. A 200 with zeroes would read as "plenty of room" on the exact
  // screen an operator opens to find out whether there is any.
  if (mbErr) return NextResponse.json({ success: false, error: mbErr.message }, { status: 500 })
  if (usageErr) return NextResponse.json({ success: false, error: usageErr.message }, { status: 500 })

  const byMailbox = new Map((usage || []).map(u => [u.mailbox_id, u]))

  // Every mailbox appears, including ones with no counter row yet — "0 of 5 GB"
  // is the honest answer for an account that has never received a file, and
  // omitting it would look like the account is missing.
  const mailboxUsage = (mailboxes || [])
    .map(m => usageEntry({ mailbox: m, row: byMailbox.get(m.id) }))
    .sort((a, b) => b.bytes_used - a.bytes_used || String(a.label).localeCompare(String(b.label)))

  // The unfiled bucket is shown ONLY when it exists — an operator who has never
  // deleted a mailbox should not be asked to reason about a concept that has
  // never applied to them.
  const unfiledRow = byMailbox.get(null)
  const unfiled = unfiledRow && Number(unfiledRow.bytes_used) > 0
    ? usageEntry({ mailbox: null, row: unfiledRow })
    : null

  return NextResponse.json({
    success: true,
    data: {
      quota_bytes: EMAIL_MAILBOX_QUOTA_BYTES,
      mailboxes: mailboxUsage,
      unfiled,
      prune_batch_limit: PRUNE_BATCH_LIMIT,
    },
  })
}

// mailbox_id is nullable ON PURPOSE — null addresses the unfiled bucket, which
// is a real bucket an operator may need to clear. `.nullable()` rather than
// `.optional()` so "the unfiled one" has to be said explicitly and a forgotten
// field cannot silently prune the wrong thing.
const StorageActionBody = z.object({
  action: z.enum(['prune', 'recalculate']),
  mailbox_id: uuidLike.nullable().optional(),
  // 0 is legal (clear everything on finished tickets) but has to be typed.
  older_than_days: z.number().int().min(0).max(3650).optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return mailboxUnauthorized()
  const guard = guardMailboxAdmin(user, params.id)
  if (guard) return guard

  const validation = await validateBody(request, StorageActionBody)
  if (!validation.ok) return validation.response
  const { action } = validation.data

  const db = createServerClient()

  if (action === 'recalculate') {
    const res = await recalcStorageUsage(db, params.id)
    if (!res.ok) {
      return NextResponse.json({ success: false, error: res.error || 'Recalculate failed' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: { recalculated: true } })
  }

  // ── Prune ───────────────────────────────────────────────────────────
  const mailboxId = validation.data.mailbox_id ?? null

  // A mailbox id from another studio must never be prunable from here. Checked
  // explicitly rather than trusted: the counter row is keyed on
  // (location_id, mailbox_id), so a foreign id would simply create an empty row
  // and prune nothing — a confusing no-op instead of a refusal.
  if (mailboxId) {
    const { data: mailbox, error: mbErr } = await db.from('email_mailboxes')
      .select('id')
      .eq('id', mailboxId)
      .eq('location_id', params.id)
      .maybeSingle()
    if (mbErr) return NextResponse.json({ success: false, error: mbErr.message }, { status: 500 })
    if (!mailbox) {
      // 404, never 403 — another studio's mailbox id must be indistinguishable
      // from one that does not exist.
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
  }

  const olderThanDays = validation.data.older_than_days ?? 365
  const result = await pruneMailboxAttachments(db, {
    locationId: params.id,
    mailboxId,
    olderThanDays,
  })
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error || 'Prune failed' }, { status: 500 })
  }

  // Destructive and irreversible — the bytes are gone from the bucket. The row
  // survives with skipped_reason 'pruned', but "who decided to delete a
  // member's attachments" is not answerable from that alone.
  if (result.pruned > 0) {
    await logAuditEvent({
      category: 'mutation',
      action: 'email_storage.pruned',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: {
        label: mailboxId ? `mailbox ${mailboxId}` : 'unfiled attachments',
        resource: `email_storage/${params.id}`,
      },
      locationId: params.id,
      details: {
        mailbox_id: mailboxId,
        older_than_days: olderThanDays,
        pruned: result.pruned,
        bytes_freed: result.bytesFreed,
      },
      request,
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      pruned: result.pruned,
      bytes_freed: result.bytesFreed,
      // >0 means the batch limit was reached and running it again will free
      // more — said out loud so an operator is never left thinking a partial
      // clear was the whole job.
      remaining: result.remaining,
    },
  })
}
