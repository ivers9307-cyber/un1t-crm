// HYROX-TC.3 — keep ~2 weeks of sessions expanded ahead of "now" for each
// active block (the rolling half of the arc-up-front + expand-rolling design).
import { anthropicMessages } from '@/lib/anthropic'
import { expandSession, HYROX_MODEL } from './generate'
import { sessionRowFrom, slotsForWeek } from './plan-block'
import { weeksNeedingExpansion } from './expand-plan'
import { resolveHyroxSettings } from './settings'
import { dublinDateKey } from '@/lib/dublin-time'
import { logWarn } from '@/lib/log'

export async function runExpandHyroxWeeks(db, { nowMs = Date.now(), aheadWeeks = 2 } = {}) {
  const stats = { blocks: 0, weeksExpanded: 0, sessionsCreated: 0 }
  const nowYmd = dublinDateKey(new Date(nowMs).toISOString())
  const { data: blocks } = await db
    .from('hyrox_blocks')
    .select('id, location_id, starts_on, weeks, sessions_per_week, difficulty_dial, arc')
    .eq('status', 'active')
  for (const block of blocks || []) {
    stats.blocks++
    try {
      const { data: existing } = await db.from('hyrox_sessions').select('week_no').eq('block_id', block.id)
      const haveWeeks = [...new Set((existing || []).map((r) => r.week_no))]
      const need = weeksNeedingExpansion(block, haveWeeks, nowYmd, aheadWeeks)
      if (!need.length) continue
      const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', block.location_id).single()
      const charter = resolveHyroxSettings(loc).charter
      const caller = makeCaller(block.location_id)
      for (const weekNo of need) {
        const week = (block.arc?.plan || []).find((w) => w.week_no === weekNo)
        if (!week) continue
        const rows = []
        for (const slot of slotsForWeek(block.sessions_per_week)) {
          const sRes = await expandSession({ week, slot, dial: block.difficulty_dial, locationLabel: (loc?.name || 'UN1T').toUpperCase(), charter, autoTuneSignal: null }, { caller })
          if (sRes.ok) rows.push(sessionRowFrom(block.id, block.location_id, { ...sRes.data, week_no: weekNo, slot }))
        }
        if (rows.length) {
          const { error } = await db.from('hyrox_sessions').insert(rows)
          if (!error) { stats.weeksExpanded++; stats.sessionsCreated += rows.length }
        }
      }
    } catch (err) {
      logWarn('hyrox-expand', `block ${block.id} failed`, { err: err?.message })
    }
  }
  return stats

  function makeCaller(locationId) {
    return async ({ system, user, maxTokens }) => {
      const { res, data } = await anthropicMessages(
        { model: HYROX_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
        { locationId, source: 'hyrox_generation' },
      )
      if (!res.ok) return { ok: false, error: `anthropic_${res.status}` }
      const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
      return { ok: true, text }
    }
  }
}
