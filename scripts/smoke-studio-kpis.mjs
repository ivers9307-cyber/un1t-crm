// STUDIO-KPI.1 smoke — run the scorecard fetchers against the live DB
// exactly as the page does, and print what each cell would render.
// Usage: node --env-file=.env.local scripts/smoke-studio-kpis.mjs <location_id>
import { createClient } from '@supabase/supabase-js'
import {
  fetchMrr, fetchGrowth, fetchRevenueChurn, fetchEngagement,
  fetchFloor, fetchAdSpend, fetchAcquisition,
} from '../shared/studio-kpis.js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('missing supabase env')
const db = createClient(url, key)

const locationId = process.argv[2]
if (!locationId) throw new Error('pass a location_id')

const mrr = await fetchMrr(db, locationId)
if (!mrr.success) throw new Error(`mrr: ${mrr.error}`)
const estYield = mrr.data.yieldCents || 0

const [growth, churn, acq, engagement, floor, spend] = await Promise.all([
  fetchGrowth(db, locationId),
  fetchRevenueChurn(db, locationId, estYield),
  fetchAcquisition(db, locationId),
  fetchEngagement(db, locationId),
  fetchFloor(db, locationId),
  fetchAdSpend(db, locationId),
])

for (const [name, r] of Object.entries({ growth, churn, acq, engagement, floor, spend })) {
  if (!r.success) throw new Error(`${name}: ${r.error}`)
}

console.log(JSON.stringify({
  mrr: mrr.data,
  growth: growth.data,
  churn: churn.data,
  acq: acq.data,
  engagement: engagement.data,
  floor: { ...floor.data, groupTable: floor.data.groupTable.slice(0, 8) },
  spend: spend.data,
}, null, 2))
