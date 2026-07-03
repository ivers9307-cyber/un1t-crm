// src/lib/ads/providers/meta.js
// Meta (Graph API) ads provider. The map* functions are pure and unit-tested;
// the fetch* functions do network I/O and call them.
import { normalizeInsightRow } from '../provider'

const GRAPH = 'https://graph.facebook.com/v21.0'
const ID_FIELD = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' }

export function extractAction(actions, type) {
  if (!Array.isArray(actions)) return 0
  const hit = actions.find((a) => a.action_type === type)
  return hit ? Number(hit.value) : 0
}

export function mapMetaInsight(raw, level) {
  const actions = raw.actions || []
  return normalizeInsightRow({
    level,
    entity_external_id: raw[ID_FIELD[level]],
    date: raw.date_start,
    spend: raw.spend, impressions: raw.impressions, reach: raw.reach, frequency: raw.frequency,
    clicks: raw.clicks, ctr: raw.ctr, cpc: raw.cpc, cpm: raw.cpm,
    link_clicks: extractAction(actions, 'link_click'),
    landing_page_views: extractAction(actions, 'landing_page_view'),
    results: extractAction(actions, 'landing_page_view'),
    result_type: 'landing_page_view',
    actions,
  })
}

export function mapMetaEntity(raw, level) {
  return {
    level, external_id: raw.id, name: raw.name || null,
    status: raw.effective_status || raw.status || null,
    campaign_external_id: raw.campaign_id || null,
    adset_external_id: raw.adset_id || null,
    raw,
  }
}

async function graphGet(path, params, token) {
  const url = new URL(`${GRAPH}/${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  url.searchParams.set('access_token', token)
  const rows = []
  let next = url.toString()
  while (next) {
    const res = await fetch(next)
    const json = await res.json()
    if (json.error) throw new Error(json.error.message)
    rows.push(...(json.data || []))
    next = json.paging?.next || null
  }
  return rows
}

export async function testMetaConnection(account) {
  try {
    const res = await fetch(`${GRAPH}/act_${account.external_account_id}?fields=name,currency,timezone_name&access_token=${account.access_token}`)
    const json = await res.json()
    if (json.error) return { success: false, error: json.error.message }
    return { success: true, name: json.name, currency: json.currency }
  } catch (e) { return { success: false, error: e.message } }
}

export async function listEntities(account) {
  const token = account.access_token
  const act = `act_${account.external_account_id}`
  const out = []
  const campaigns = await graphGet(`${act}/campaigns`, { fields: 'id,name,effective_status', limit: '200' }, token)
  campaigns.forEach((c) => out.push(mapMetaEntity(c, 'campaign')))
  const adsets = await graphGet(`${act}/adsets`, { fields: 'id,name,effective_status,campaign_id', limit: '200' }, token)
  adsets.forEach((a) => out.push(mapMetaEntity(a, 'adset')))
  const ads = await graphGet(`${act}/ads`, { fields: 'id,name,effective_status,campaign_id,adset_id', limit: '500' }, token)
  ads.forEach((a) => out.push(mapMetaEntity(a, 'ad')))
  return out
}

export async function fetchInsights(account, { since, until, level, breakdown }) {
  const token = account.access_token
  const act = `act_${account.external_account_id}`
  const params = {
    level,
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    fields: 'campaign_id,adset_id,ad_id,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,date_start,date_stop',
    limit: '500',
  }
  if (breakdown) params.breakdowns = breakdown
  const rows = await graphGet(`${act}/insights`, params, token)
  return rows.map((r) => {
    const row = mapMetaInsight(r, level)
    if (breakdown) { row.dimension = breakdown; row.segment = r[breakdown] || 'unknown' }
    return row
  })
}
