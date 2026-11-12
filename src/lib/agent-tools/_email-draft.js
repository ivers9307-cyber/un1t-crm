// MCPEMAIL.1 — helpers shared by the three email-campaign WRITE tools
// (create / update / cancel). Not a tool itself (no defineTool).

import { ToolRefusal } from './registry.js'
import { EmailBlocksSchema, validateBlocks, renderAgentEmail } from '@/lib/agent-email-blocks'
import { getLocationBranding } from '@/lib/location-branding'
import { describeFromAddress } from '@/lib/from-address'
import { allowedImageUrls, htmlSha256 } from './_email-campaign.js'

// Postgres check_violation: what the campaign status triggers (migs 522/523)
// raise when a status moved past 'scheduled' between our read and our write.
// Held here, not imported from campaign-session-access (which pulls next/server).
export const CHECK_VIOLATION = '23514'

export const BODY_EDITED_IN_CRM = 'The body was edited in the CRM. Edit the body there.'

export { EmailBlocksSchema }

/** A refused write: a status trigger fired, or the supabase error is thrown as a failure. */
export function throwWriteError(error, what) {
  if (error?.code === CHECK_VIOLATION) {
    throw new ToolRefusal('conflict', "The campaign's status changed, so it can no longer be edited. Check it with get_email_campaign.")
  }
  throw new Error(`Failed to ${what}: ${error?.message || 'no row returned'}`)
}

/** The address the studio sends as (the tools never set from_email). */
export async function sendsAs(db, studio) {
  const { sends_as } = await describeFromAddress(db, studio.id, null)
  return sends_as ?? null
}

/** reply_to must be on the studio's verified sending domain. */
export async function checkReplyTo(db, studio, replyTo) {
  const d = await describeFromAddress(db, studio.id, replyTo)
  if (d.on_verified_domain) return
  throw new ToolRefusal('invalid_input', d.verified_domain
    ? `reply_to must be an address on the studio's verified domain (${d.verified_domain}).`
    : 'This studio has no verified sending domain, so a reply_to cannot be set.')
}

/**
 * Blocks → the stored body. Order is binding: schema (already in the tool's
 * inputSchema) → validateBlocks → render. Never renders unvalidated blocks.
 * Returns the columns to write together (Ruling A).
 */
export async function buildBody(db, user, studio, blocks) {
  const problem = validateBlocks(blocks, { allowedImageUrls: await allowedImageUrls(db, user, studio) })
  if (problem) throw new ToolRefusal('invalid_input', problem)
  const b = await getLocationBranding(db, studio.id)
  const html = renderAgentEmail({ blocks, branding: { companyName: b?.companyName ?? '', logoUrl: b?.logoUrl ?? null } })
  return { html_content: html, agent_blocks: { v: 1, blocks, html_sha256: htmlSha256(html) } }
}
