// MCPEMAIL.1 — campaign release approvals. A tool cannot send a campaign: it
// emails a person a test with an approve link, and a signed-in press on a CRM
// page releases it. An approval is bound to the campaign's exact content (the
// content key), to one person (profile_id) and is single-use (consume is a
// compare-and-set). Only the sha256 of the link token is stored.
//
// public.campaign_release_approvals is service-role only (mig 830). One live
// (unused, unvoided) approval per campaign is enforced by the partial unique
// index campaign_release_approvals_one_live: of two concurrent issues the
// losing insert gets 23505 and throws (fail closed). An expired but unvoided
// row is still live for that index, so issuing voids ALL unused rows.

import { createHash, randomBytes } from 'node:crypto'

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
export const APPROVALS_PER_HOUR = 5
// Every campaigns column the sender reads that changes who gets what: the
// eight a tool writes, plus the five a tool never sets but the CRM can (the
// Duplicate button copies ab_* and postmark_stream onto a draft).
export const APPROVAL_CONTENT_FIELDS = [
  'location_id', 'subject', 'preview_text', 'from_name', 'from_email', 'reply_to', 'html_content', 'audience_filter',
  'postmark_stream', 'ab_subject_b', 'ab_test_pct', 'ab_wait_hours', 'parent_campaign_id',
]

const TABLE = 'campaign_release_approvals'
// Named columns, never '*', and never token_hash.
const APPROVAL_COLUMNS = 'id, campaign_id, profile_id, content_key, audience_eligible, send_at, expires_at, used_at, voided_at, created_at'

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// Recursively sorted keys; arrays keep their order; undefined becomes null.
function stable(v) {
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(stable)
  if (typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
  }
  return v
}

/** sha256 hex over a stable JSON of the fields a release is approved on (APPROVAL_CONTENT_FIELDS). */
export function campaignContentKey(row) {
  const picked = {}
  for (const f of APPROVAL_CONTENT_FIELDS) {
    // A short select must never silently weaken the binding.
    if (!row || !(f in row)) throw new Error(`campaignContentKey: row is missing field '${f}'`)
    picked[f] = row[f]
  }
  return sha256(JSON.stringify(stable(picked)))
}

/**
 * Why a campaign cannot be released through an agent approval, or null. The
 * test email and the approve page show neither a B subject, a resend's
 * non-opener audience nor a utility stream, so a campaign carrying any of them
 * is the CRM's to send. Judged the way campaign-sender.js judges them: any
 * truthy ab_subject_b is an A/B test, any parent_campaign_id a resend, and
 * anything but 'broadcast' is not the marketing stream.
 */
export function agentReleaseBlocker(campaign) {
  if (campaign?.ab_subject_b) return 'This campaign has a subject A/B test. Open it in the CRM.'
  if (campaign?.parent_campaign_id) return 'This campaign is a resend. Open it in the CRM.'
  if (campaign?.postmark_stream !== 'broadcast') return 'This campaign is not on the marketing stream. Open it in the CRM.'
  return null
}

/** The audience grew past what the person tested: more than 10% AND more than 25 people. */
export function audienceGrewTooMuch(tested, now) {
  return now > tested * 1.10 && now - tested > 25
}

/**
 * Issue a one-time approval for `campaign` to `profileId`. The token is
 * returned once and stored nowhere. Earlier unused approvals are voided first;
 * if that fails nothing is inserted.
 */
export async function issueApproval(db, { campaign, profileId, audienceEligible, sendAt, nowMs }) {
  const hourAgo = new Date(nowMs - 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await db
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id)
    .gte('created_at', hourAgo)
  if (countError) throw new Error(`approval count failed: ${countError.message}`)
  if (typeof count !== 'number') throw new Error('approval count returned no number')
  if (count >= APPROVALS_PER_HOUR) return { ok: false, code: 'too_many' }

  await voidApprovals(db, campaign.id, nowMs)

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(nowMs + APPROVAL_TTL_MS).toISOString()
  const { data, error } = await db
    .from(TABLE)
    .insert({
      campaign_id: campaign.id,
      profile_id: profileId,
      token_hash: sha256(token),
      content_key: campaignContentKey(campaign),
      audience_eligible: audienceEligible,
      send_at: sendAt ?? null,
      expires_at: expiresAt,
      created_at: new Date(nowMs).toISOString(),
    })
    .select('id')
  if (error) throw new Error(`approval insert failed: ${error.message}`)
  if (!Array.isArray(data) || data.length !== 1) throw new Error('approval insert wrote no row')
  return { ok: true, token, expiresAt }
}

/**
 * Look an approval up by its token. Another person's token and an unknown one
 * both answer not_found, so a token cannot be probed across people.
 */
export async function findApproval(db, { token, profileId, nowMs }) {
  const { data, error } = await db
    .from(TABLE)
    .select(APPROVAL_COLUMNS)
    .eq('token_hash', sha256(String(token ?? '')))
    .eq('profile_id', profileId)
    .maybeSingle()
  if (error) throw new Error(`approval read failed: ${error.message}`)
  if (!data) return { ok: false, code: 'not_found' }
  if (data.used_at) return { ok: false, code: 'used' }
  if (data.voided_at) return { ok: false, code: 'voided' }
  if (Date.parse(data.expires_at) <= nowMs) return { ok: false, code: 'expired' }
  return { ok: true, approval: data }
}

/** Spend an approval. True only when this call touched exactly one row. */
export async function consumeApproval(db, approvalId, nowMs = Date.now()) {
  const { data, error } = await db
    .from(TABLE)
    .update({ used_at: new Date(nowMs).toISOString() })
    .eq('id', approvalId)
    .is('used_at', null)
    .is('voided_at', null)
    .gt('expires_at', new Date(nowMs).toISOString())
    .select('id')
  if (error) throw new Error(`approval consume failed: ${error.message}`)
  return Array.isArray(data) && data.length === 1
}

/** Withdraw every unused approval of a campaign (content changed, stopped, sent). */
export async function voidApprovals(db, campaignId, nowMs = Date.now()) {
  const { error } = await db
    .from(TABLE)
    .update({ voided_at: new Date(nowMs).toISOString() })
    .eq('campaign_id', campaignId)
    .is('used_at', null)
    .is('voided_at', null)
  if (error) throw new Error(`approval void failed: ${error.message}`)
}

/** The campaign's live approval (unused, unvoided, unexpired), or null. */
export async function pendingApproval(db, campaignId, nowMs) {
  const { data, error } = await db
    .from(TABLE)
    .select('send_at, expires_at, audience_eligible')
    .eq('campaign_id', campaignId)
    .is('used_at', null)
    .is('voided_at', null)
    .gt('expires_at', new Date(nowMs).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`approval read failed: ${error.message}`)
  return data ?? null
}
