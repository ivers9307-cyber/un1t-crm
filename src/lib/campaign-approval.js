// MCPEMAIL.1 — campaign release approvals. A tool cannot send a campaign: it
// emails a person a test with an approve link, and a signed-in press on a CRM
// page releases it. An approval is bound to the campaign's exact content (the
// content key), to one person (profile_id) and is single-use (consume is a
// compare-and-set). Only the sha256 of the link token is stored.
//
// public.campaign_release_approvals is service-role only (mig 827).

import { createHash, randomBytes } from 'node:crypto'

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
export const APPROVALS_PER_HOUR = 5
export const APPROVAL_CONTENT_FIELDS = [
  'location_id', 'subject', 'preview_text', 'from_name', 'reply_to', 'html_content', 'audience_filter',
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

/** sha256 hex over a stable JSON of the seven fields a release is approved on. */
export function campaignContentKey(row) {
  const picked = {}
  for (const f of APPROVAL_CONTENT_FIELDS) picked[f] = row?.[f]
  return sha256(JSON.stringify(stable(picked)))
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
  if ((count ?? 0) >= APPROVALS_PER_HOUR) return { ok: false, code: 'too_many' }

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
export async function consumeApproval(db, approvalId) {
  const { data, error } = await db
    .from(TABLE)
    .update({ used_at: new Date().toISOString() })
    .eq('id', approvalId)
    .is('used_at', null)
    .is('voided_at', null)
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
