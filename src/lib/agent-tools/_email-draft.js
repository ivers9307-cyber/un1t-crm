// MCPEMAIL.1 — helpers shared by the three email-campaign WRITE tools
// (create / update / cancel). Not a tool itself (no defineTool).

import { z } from 'zod'
import { ToolRefusal } from './registry.js'
import { EmailBlocksSchema, validateBlocks, renderAgentEmail, mergeTagProblem } from '@/lib/agent-email-blocks'
import { getEmailLogoUrl } from '@/lib/email-logo'
import { RESEND_MIN_WAIT_HOURS, RESEND_MAX_WAIT_HOURS } from '@/lib/campaign-resend'
import { getLocationBranding } from '@/lib/location-branding'
import { describeFromAddress } from '@/lib/from-address'
import { allowedImageUrls, htmlSha256 } from './_email-campaign.js'

// Postgres check_violation: what the campaign status triggers (migs 522/523)
// raise when a status moved past 'scheduled' between our read and our write.
// Held here, not imported from campaign-session-access (which pulls next/server).
export const CHECK_VIOLATION = '23514'

export const BODY_EDITED_IN_CRM = 'The body was edited in the CRM. Edit the body there.'

export { EmailBlocksSchema }

/**
 * CONDBLOCKS.2 — how an agent writes merge tags and conditional text, shared by
 * every email-draft tool description so they cannot drift.
 * mergeTagProblem() (agent-email-blocks.js) enforces exactly this.
 */
export const MERGE_TAG_HELP = 'Merge tags are written exactly like {{first_name}}, or {{first_name|there}} for a fallback when the value is blank. '
  + 'Conditional text: {{#if member}}…{{else}}…{{/if}} (a current member), {{#if first_name}}…{{/if}} (has a first name), '
  + '{{#if stage=dormant}}…{{/if}} (pipeline stage is that slug); {{#unless …}}…{{/unless}} is the opposite. '
  + '{{else}} is optional. A block opens and closes inside one text (a paragraph, heading, list item, button label or the subject), '
  + 'blocks do not nest, and an unknown or badly written condition is refused. Links and image addresses take no conditions.'

/** A subject with an unknown tag or a badly formed conditional block is refused. */
export function checkSubject(subject, where = 'The subject') {
  if (subject == null) return
  const problem = mergeTagProblem(subject)
  if (problem) throw new ToolRefusal('invalid_input', `${where}: ${problem}`)
}

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
  const emailLogoUrl = await getEmailLogoUrl(db, studio.id)
  const html = renderAgentEmail({ blocks, branding: { companyName: b?.companyName ?? '', logoUrl: b?.logoUrl ?? null, emailLogoUrl } })
  return { html_content: html, agent_blocks: { v: 1, blocks, html_sha256: htmlSha256(html) } }
}

/**
 * MCPEMAIL.2 — a resend to people who did not open it. `null` switches it off,
 * `undefined` (omitted) leaves it as it is on an update.
 */
export const ResendSchema = z.object({
  after_hours: z.number().int().min(RESEND_MIN_WAIT_HOURS).max(RESEND_MAX_WAIT_HOURS)
    .describe(`Hours after the send to resend to people who did not open it, ${RESEND_MIN_WAIT_HOURS} to ${RESEND_MAX_WAIT_HOURS}.`),
  subject: z.string().trim().min(1).max(200).optional()
    .describe(`Subject for the resend; omit to reuse the campaign subject. ${MERGE_TAG_HELP}`),
}).nullable().optional()

/**
 * The campaigns columns for a `resend` input. Enabled always carries its hours
 * (the spawner needs them). Refuses a subject with an unknown or spaced tag
 * or a badly formed conditional block.
 */
export function resendColumns(resend) {
  if (resend === undefined) return {}
  if (resend === null) return { resend_enabled: false, resend_wait_hours: null, resend_subject: null }
  checkSubject(resend.subject, 'The resend subject')
  return { resend_enabled: true, resend_wait_hours: resend.after_hours, resend_subject: resend.subject ?? null }
}
