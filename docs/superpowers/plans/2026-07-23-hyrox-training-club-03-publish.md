# Hyrox Training Club — Plan 03: auto-publish to the TV + rolling expansion

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Close the loop. A cron publishes the approved Hyrox session to the gym TV at class time on a purpose-built portrait board (`source_type='generated'`), reverts to idle after class, and a nightly cron keeps ~2 weeks of sessions expanded ahead of "now".

**Architecture:** Reuse the existing TV cast pipeline — light up the dormant `tv_content.source_type='generated'` with a new `<HyroxBoard>` render branch; the publish cron mirrors the manual `tv_content` upsert server-side (service-role), keyed to the live HYROX `class_occurrences` row mapped to an approved `hyrox_sessions` (by `location_id + week_no + slot`, never `glofox_event_id`). Idempotency via `hyrox_sessions.status='published'` + only-push-on-change. Board JSON stays authoritative on `hyrox_sessions.board`; `tv_content.source_ref` holds the session id and the public content route re-fetches it (no stale snapshot). Pure decision helpers are unit-tested; cron IO is thin.

**Tech stack:** Next.js 16 · Supabase (service-role crons) · Vercel Cron · zod ^4 · vitest ^4 · `anthropicMessages` (expansion).

**Spec coverage:** §6 (auto-publish cron + lead time + safe degradation + revert), §7 (purpose-built portrait `generated` board), §4.1 (rolling-expansion cron for weeks past the initial window). After this plan the feature is end-to-end for Stillorgan. Still deferred: §8.3 auto-tune signal computation (Phase 2), a second location (Phase 2), benchmark score capture, the champ-app member view (Phase 3).

**Before you start:** branch `hyrox-training-club-03-publish` (worktree `~/code/un1t-crm-hyrox`), off merged `main` (Plans 01+02 present). One migration (heartbeat seed) applies to prod via Supabase MCP — the controller checkpoints before applying. Register nothing in openapi (crons aren't in the OpenAPI surface). Run the six-check mirror + `npm run build` before finishing.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/hyrox/publish.js` (+test) | Pure: `pickSessionForOccurrence`, `resolveHyroxDisplayIds` |
| `src/lib/hyrox/expand-plan.js` (+test) | Pure: `currentWeekNo`, `weeksNeedingExpansion` |
| `src/components/HyroxBoard.jsx` | Portrait `generated` TV board (renders `boardSchema`) |
| `src/app/tv/cast/[token]/TVDisplay.jsx` (edit) | Add the `generated` → `<HyroxBoard>` render branch |
| `src/app/api/public/tv/[token]/content/route.js` (edit) | Return `content.board` for `source_type='generated'` |
| `src/lib/hyrox/publish-runner.js` | Cron runner: reconcile each location's target TV(s) to the live class's board |
| `src/app/api/cron/publish-hyrox-board/route.js` | Cron route (Bearer CRON_SECRET → runner → heartbeat) |
| `src/lib/hyrox/expand-runner.js` | Cron runner: expand weeks needing sessions (~2 ahead) |
| `src/app/api/cron/expand-hyrox-weeks/route.js` | Cron route |
| `supabase/migrations/<NNN>_hyrox_crons.sql` | Seed `cron_heartbeats` for both crons |
| `vercel.json` (edit) | Register both cron schedules |

---

## Task 1: pure decision helpers

**Files:** `src/lib/hyrox/publish.js` (+`.test.js`), `src/lib/hyrox/expand-plan.js` (+`.test.js`)

- [ ] **Step 1: Write the failing tests.**
  `publish.test.js`:
  ```js
  import { describe, it, expect } from 'vitest'
  import { pickSessionForOccurrence, resolveHyroxDisplayIds } from './publish'

  const block = { starts_on: '2026-08-03', weeks: 12, session_weekdays: [3, 7] } // Mon start; Wed=slot1, Sun=slot2
  const sessions = [
    { id: 's1', week_no: 1, slot: 1, status: 'approved' },
    { id: 's2', week_no: 1, slot: 2, status: 'draft' },
    { id: 's3', week_no: 2, slot: 1, status: 'published' },
  ]

  describe('pickSessionForOccurrence', () => {
    it('matches an approved session to the live class by week+slot', () => {
      // Wed 2026-08-05 18:00 = week 1 (0-2 days in), slot 1 (Wed)
      expect(pickSessionForOccurrence(block, sessions, '2026-08-05T18:00:00Z')?.id).toBe('s1')
    })
    it('returns null when the matching session is still a draft', () => {
      // Sun 2026-08-09 = week 1, slot 2 -> s2 is draft
      expect(pickSessionForOccurrence(block, sessions, '2026-08-09T10:00:00Z')).toBeNull()
    })
    it('matches a published session too', () => {
      // Wed 2026-08-12 = week 2, slot 1 -> s3 published
      expect(pickSessionForOccurrence(block, sessions, '2026-08-12T18:00:00Z')?.id).toBe('s3')
    })
    it('returns null before the block starts', () => {
      expect(pickSessionForOccurrence(block, sessions, '2026-07-30T18:00:00Z')).toBeNull()
    })
  })

  describe('resolveHyroxDisplayIds', () => {
    it('returns all active displays when unset', () => {
      expect(resolveHyroxDisplayIds({}, ['d1', 'd2'])).toEqual(['d1', 'd2'])
    })
    it('narrows to the configured display ids (intersected with active)', () => {
      const loc = { settings: { hyrox: { tv_display_ids: ['d2', 'dX'] } } }
      expect(resolveHyroxDisplayIds(loc, ['d1', 'd2'])).toEqual(['d2'])
    })
    it('falls back to all active if the configured list is empty', () => {
      const loc = { settings: { hyrox: { tv_display_ids: [] } } }
      expect(resolveHyroxDisplayIds(loc, ['d1'])).toEqual(['d1'])
    })
  })
  ```
  `expand-plan.test.js`:
  ```js
  import { describe, it, expect } from 'vitest'
  import { currentWeekNo, weeksNeedingExpansion } from './expand-plan'

  const block = { starts_on: '2026-08-03', weeks: 12 } // Mon

  describe('currentWeekNo', () => {
    it('is week 1 in the first 7 days', () => {
      expect(currentWeekNo('2026-08-03', '2026-08-03')).toBe(1)
      expect(currentWeekNo('2026-08-03', '2026-08-09')).toBe(1)
    })
    it('is week 2 on day 8', () => {
      expect(currentWeekNo('2026-08-03', '2026-08-10')).toBe(2)
    })
    it('is null before the start', () => {
      expect(currentWeekNo('2026-08-03', '2026-08-01')).toBeNull()
    })
  })

  describe('weeksNeedingExpansion', () => {
    it('returns current..+2 weeks that have no sessions yet', () => {
      // current week 3; weeks 1-2 already expanded
      expect(weeksNeedingExpansion(block, [1, 2, 3], '2026-08-17', 2)).toEqual([4, 5])
    })
    it('clamps to block.weeks', () => {
      const b = { starts_on: '2026-08-03', weeks: 12 }
      // near the end: current week 12
      expect(weeksNeedingExpansion(b, [], '2026-10-19', 2)).toEqual([12])
    })
    it('is empty before the block starts', () => {
      expect(weeksNeedingExpansion(block, [], '2026-08-01', 2)).toEqual([])
    })
  })
  ```

- [ ] **Step 2: Run — expect fail** (`npx vitest run src/lib/hyrox/publish.test.js src/lib/hyrox/expand-plan.test.js`).

- [ ] **Step 3: Write `publish.js`.**
  ```js
  // HYROX-TC.3 — pure decisions for the publish cron. No IO.
  import { weekNoFor, slotFor } from './mapping'

  // The approved/published session that a live HYROX occurrence maps to, or null.
  export function pickSessionForOccurrence(block, sessions, occurrenceIso) {
    const wk = weekNoFor(block.starts_on, occurrenceIso, block.weeks)
    if (wk == null) return null
    const slot = slotFor(block.session_weekdays, occurrenceIso)
    if (slot == null) return null
    return (sessions || []).find(
      (s) => s.week_no === wk && s.slot === slot && (s.status === 'approved' || s.status === 'published'),
    ) || null
  }

  // Which of a location's active TV displays should show the Hyrox board.
  // Operator can restrict via locations.settings.hyrox.tv_display_ids; unset/empty = all active.
  export function resolveHyroxDisplayIds(loc, activeDisplayIds) {
    const ids = loc?.settings?.hyrox?.tv_display_ids
    if (Array.isArray(ids) && ids.length) return activeDisplayIds.filter((id) => ids.includes(id))
    return activeDisplayIds
  }
  ```

- [ ] **Step 4: Write `expand-plan.js`.**
  ```js
  // HYROX-TC.3 — pure: which weeks the rolling-expansion cron should fill. No IO.
  import { daysBetween } from './mapping'

  export function currentWeekNo(startsOn, nowYmd) {
    const diff = daysBetween(startsOn, nowYmd)
    if (!Number.isFinite(diff) || diff < 0) return null
    return Math.floor(diff / 7) + 1
  }

  // current..current+aheadWeeks (clamped to block.weeks) that have zero sessions yet.
  export function weeksNeedingExpansion(block, existingWeekNos, nowYmd, aheadWeeks = 2) {
    const cur = currentWeekNo(block.starts_on, nowYmd)
    if (cur == null) return []
    const have = new Set(existingWeekNos)
    const out = []
    for (let w = cur; w <= Math.min(cur + aheadWeeks, block.weeks); w++) {
      if (w >= 1 && !have.has(w)) out.push(w)
    }
    return out
  }
  ```

- [ ] **Step 5: Run — expect pass** (both files, under `TZ=Europe/Dublin` and `TZ=America/New_York` since these use Dublin date math).

- [ ] **Step 6: Commit** (`HYROX-TC.3 — pure publish/expansion decision helpers`).

---

## Task 2: the `<HyroxBoard>` portrait board component

**Files:** `src/components/HyroxBoard.jsx`

> Inline hex styles (not Tailwind chips) so the `no-low-contrast-chip` guardrail does not apply. Sizes in `cqw/cqh` so it fills the rotated stage (`TVDisplay` sets `containerType: 'size'`). Uses `tvFontFamily` (Poppins) to match the other TV surfaces. Renders the `boardSchema` shape from `src/lib/hyrox/schema.js` (`wordmark`, `location_label`, `week_label`, `focus`, `format`, `cap_minutes`, `stations[{name,performance,elite}]`, `target`). This is the approved portrait mockup.

- [ ] **Step 1: Write `HyroxBoard.jsx`.**
  ```jsx
  'use client'
  import { tvFontFamily } from './tv-font'

  export default function HyroxBoard({ board }) {
    if (!board) return null
    const stations = Array.isArray(board.stations) ? board.stations : []
    const gold = '#d8b24a'
    const col = { display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', alignItems: 'center' }
    return (
      <div style={{ position: 'absolute', inset: 0, background: '#0d0d0f', color: '#f4f4f5', fontFamily: tvFontFamily, display: 'flex', flexDirection: 'column', padding: '6cqh 5cqw', boxSizing: 'border-box' }}>
        <div style={{ textAlign: 'center', borderBottom: '1px solid #2a2a2e', paddingBottom: '3cqh' }}>
          <div style={{ fontSize: '2.4cqh', letterSpacing: '0.5cqw', color: '#8a8a90' }}>{board.location_label || ''}</div>
          <div style={{ fontSize: '9cqh', fontWeight: 600, letterSpacing: '0.3cqw', lineHeight: 1, marginTop: '1cqh' }}>HYROX</div>
          <div style={{ fontSize: '3cqh', letterSpacing: '1.2cqw', color: gold, marginTop: '0.6cqh' }}>TRAINING CLUB</div>
        </div>
        <div style={{ textAlign: 'center', padding: '3cqh 0', borderBottom: '1px solid #2a2a2e' }}>
          <div style={{ fontSize: '2.6cqh', letterSpacing: '0.5cqw', color: '#8a8a90' }}>{board.week_label || ''}</div>
          {board.focus ? <div style={{ fontSize: '3.4cqh', fontWeight: 500, color: gold, marginTop: '1cqh' }}>{board.focus}</div> : null}
        </div>
        <div style={{ textAlign: 'center', padding: '3cqh 0 2cqh' }}>
          <div style={{ fontSize: '5cqh', fontWeight: 600, letterSpacing: '0.2cqw' }}>{board.format || ''}</div>
          {board.cap_minutes ? <div style={{ fontSize: '2.6cqh', color: '#8a8a90', marginTop: '0.6cqh' }}>{`CAP ${board.cap_minutes}:00`}</div> : null}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ ...col, fontSize: '2.2cqh', letterSpacing: '0.3cqw', color: '#8a8a90', padding: '1.4cqh 0' }}>
            <div style={{ textAlign: 'left' }}>STATION</div>
            <div style={{ textAlign: 'right', color: gold }}>PERFORMANCE</div>
            <div style={{ textAlign: 'right' }}>ELITE</div>
          </div>
          {stations.map((s, i) => (
            <div key={i} style={{ ...col, fontSize: '3cqh', padding: '1.8cqh 0', borderTop: '1px solid #1f1f22' }}>
              <div style={{ textAlign: 'left' }}>{s.name}</div>
              <div style={{ textAlign: 'right', color: '#f4d98a' }}>{s.performance ?? ''}</div>
              <div style={{ textAlign: 'right' }}>{s.elite ?? ''}</div>
            </div>
          ))}
        </div>
        {board.target ? <div style={{ textAlign: 'center', borderTop: '1px solid #2a2a2e', paddingTop: '2.4cqh', fontSize: '2.4cqh', color: '#c8c8cc' }}>{board.target}</div> : null}
      </div>
    )
  }
  ```

- [ ] **Step 2: Commit** (`HYROX-TC.3 — HyroxBoard portrait TV component`).

---

## Task 3: wire the `generated` source_type through render + route

**Files:** `src/app/api/public/tv/[token]/content/route.js` (edit), `src/app/tv/cast/[token]/TVDisplay.jsx` (edit)

- [ ] **Step 1: Content route — add the `generated` arm.** After the existing `template` resolution block, add a branch that, for `content.source_type === 'generated'`, re-fetches the authoritative board from `hyrox_sessions` by `source_ref` (the session id):
  ```js
  let board = null
  // ... existing storage/url/template resolution ...
  } else if (content.source_type === 'generated') {
    const { data: sess } = await db.from('hyrox_sessions').select('board').eq('id', content.source_ref).maybeSingle()
    board = sess?.board || null
  }
  ```
  Then widen the `renderable` guard so a generated push only renders when it has a board:
  ```js
  const renderable = content && (
    content.source_type === 'template' ? Boolean(template)
    : content.source_type === 'generated' ? Boolean(board)
    : true
  )
  ```
  And add `board` to the returned content object:
  ```js
  content: renderable ? { source_type: content.source_type, resolved_url: resolvedUrl, label: content.label, pushed_at: content.pushed_at, triggered_by: content.triggered_by, template, board } : null,
  ```
  (Match the exact field names already used in the file; `board` is `null` for non-generated.)

- [ ] **Step 2: TVDisplay — add the render branch.** Import `HyroxBoard` next to the `TemplateCanvas` import, and add a branch BEFORE the generic `content?.resolved_url` `<img>` fallback:
  ```jsx
  } else if (content?.source_type === 'generated' && content?.board) {
    body = <HyroxBoard board={content.board} />
  } else if (content?.resolved_url) {
    // ...existing img...
  }
  ```

- [ ] **Step 3: Verify build.** Run `npm run build` — the cast route + content route compile. (No unit test — the render path is exercised by build + a manual check.)

- [ ] **Step 4: Commit** (`HYROX-TC.3 — render generated Hyrox board on the cast TV`).

---

## Task 4: publish cron

**Files:** `src/lib/hyrox/publish-runner.js`, `src/app/api/cron/publish-hyrox-board/route.js`

- [ ] **Step 1: Write the runner** `src/lib/hyrox/publish-runner.js` (thin IO; the decisions are Task 1's pure helpers).
  ```js
  // HYROX-TC.3 — reconcile each location's target TV(s) to the CURRENT live
  // HYROX class's approved board. Publishes ~lead-time before class; reverts a
  // stale cron board to idle when no class is live. Idempotent + push-on-change.
  import { normalizeClassName } from '@/lib/hr-analytics'
  import { pickSessionForOccurrence, resolveHyroxDisplayIds } from './publish'
  import { logWarn } from '@/lib/log'

  const LEAD_MS = 15 * 60_000   // put the board up 15 min before class
  const POST_MS = 5 * 60_000    // keep it a few min after the start
  const TRIGGER = 'cron:hyrox-publish'

  export async function runPublishHyroxBoard(db, { nowMs = Date.now() } = {}) {
    const stats = { locations: 0, pushed: 0, reverted: 0 }
    const { data: blocks } = await db
      .from('hyrox_blocks').select('id, location_id, starts_on, weeks, session_weekdays').eq('status', 'active')
    for (const block of blocks || []) {
      stats.locations++
      try {
        const { data: loc } = await db.from('locations').select('id, settings').eq('id', block.location_id).single()
        const { data: displays } = await db.from('tv_displays').select('id, tv_content(source_type, source_ref, triggered_by)').eq('location_id', block.location_id).eq('active', true)
        const activeIds = (displays || []).map((d) => d.id)
        const targetIds = resolveHyroxDisplayIds(loc, activeIds)
        if (!targetIds.length) continue

        // Find a live/imminent HYROX occurrence.
        const nowIso = new Date(nowMs).toISOString()
        const { data: occs } = await db.from('class_occurrences')
          .select('glofox_event_id, name, starts_at, ends_at')
          .eq('location_id', block.location_id)
          .is('cancelled_at', null)
          .gte('starts_at', new Date(nowMs - 3 * 60 * 60_000).toISOString())
          .lte('starts_at', new Date(nowMs + LEAD_MS).toISOString())
          .order('starts_at', { ascending: false })
        const live = (occs || []).find((o) => {
          if (normalizeClassName(o.name) !== 'hyrox') return false
          const start = new Date(o.starts_at).getTime()
          const end = o.ends_at ? new Date(o.ends_at).getTime() : start + 60 * 60_000
          return nowMs >= start - LEAD_MS && nowMs <= end + POST_MS
        })

        const session = live ? pickSessionForOccurrence(block, await loadSessions(db, block.id), live.starts_at) : null

        for (const d of displays.filter((x) => targetIds.includes(x.id))) {
          const cur = Array.isArray(d.tv_content) ? d.tv_content[0] : d.tv_content
          if (session) {
            const already = cur && cur.source_type === 'generated' && cur.source_ref === session.id
            if (!already) {
              await db.from('tv_content').upsert({
                tv_display_id: d.id, source_type: 'generated', source_ref: session.id,
                label: 'Hyrox Training Club', template_values: null,
                pushed_at: new Date().toISOString(), pushed_by: null, triggered_by: TRIGGER,
              }, { onConflict: 'tv_display_id' })
              stats.pushed++
            }
          } else if (cur && cur.triggered_by === TRIGGER) {
            // No live class + the board on screen is ours -> revert to idle.
            await db.from('tv_content').delete().eq('tv_display_id', d.id)
            stats.reverted++
          }
        }
        // Mark the session published once (idempotent).
        if (session && session.status !== 'published') {
          await db.from('hyrox_sessions').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', session.id).eq('status', 'approved')
        }
      } catch (err) {
        logWarn('hyrox-publish', `location ${block.location_id} failed`, { err: err?.message })
      }
    }
    return stats
  }

  async function loadSessions(db, blockId) {
    const { data } = await db.from('hyrox_sessions').select('id, week_no, slot, status').eq('block_id', blockId).in('status', ['approved', 'published'])
    return data || []
  }
  ```

- [ ] **Step 2: Write the cron route** `src/app/api/cron/publish-hyrox-board/route.js` (mirror `class-climate/route.js`).
  ```js
  import { NextResponse } from 'next/server'
  import { createServerClient } from '@/lib/supabase'
  import { stampHeartbeat } from '@/lib/cron-heartbeat'
  import { runPublishHyroxBoard } from '@/lib/hyrox/publish-runner'
  import { logWarn } from '@/lib/log'

  export const runtime = 'nodejs'
  export const dynamic = 'force-dynamic'
  export const maxDuration = 60

  export async function GET(request) {
    const auth = request.headers.get('authorization') || ''
    if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
    }
    const db = createServerClient()
    const stats = await runPublishHyroxBoard(db)
    await stampHeartbeat('publish-hyrox-board').catch((err) => logWarn('hyrox-publish', 'heartbeat failed', { err }))
    return NextResponse.json({ success: true, stats })
  }
  ```

- [ ] **Step 3: Verify** (`npm run check:route-guards && npm run build`).

- [ ] **Step 4: Commit** (`HYROX-TC.3 — publish-hyrox-board cron + runner`).

---

## Task 5: rolling-expansion cron

**Files:** `src/lib/hyrox/expand-runner.js`, `src/app/api/cron/expand-hyrox-weeks/route.js`

- [ ] **Step 1: Write the runner** `src/lib/hyrox/expand-runner.js`.
  ```js
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
  ```

- [ ] **Step 2: Write the cron route** `src/app/api/cron/expand-hyrox-weeks/route.js` (same shape as Task 4 Step 2, calling `runExpandHyroxWeeks`, `stampHeartbeat('expand-hyrox-weeks')`, `maxDuration = 300` since it makes multiple Claude calls).

- [ ] **Step 3: Verify** (`npm run check:route-guards && npm run build`).

- [ ] **Step 4: Commit** (`HYROX-TC.3 — expand-hyrox-weeks rolling cron + runner`).

---

## Task 6: migration + cron registration + full verify

**Files:** `supabase/migrations/<NNN>_hyrox_crons.sql`, `vercel.json` (edit)

- [ ] **Step 1: Write the migration** (use the next free number — `ls supabase/migrations | sort | tail -3`).
  ```sql
  -- <NNN>: HYROX-TC.3 — heartbeats for the two Hyrox crons.
  INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
  VALUES ('publish-hyrox-board', 300, 600, NOW()) ON CONFLICT (name) DO NOTHING;
  INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
  VALUES ('expand-hyrox-weeks', 86400, 43200, NOW()) ON CONFLICT (name) DO NOTHING;
  ```
  **The controller applies this via Supabase MCP after a checkpoint** (it is a prod write). `stampHeartbeat` names MUST equal these exactly (`publish-hyrox-board`, `expand-hyrox-weeks`).

- [ ] **Step 2: Register the crons in `vercel.json`** (append before the closing `]` of the `crons` array):
  ```json
  { "path": "/api/cron/publish-hyrox-board", "schedule": "*/5 * * * *" },
  { "path": "/api/cron/expand-hyrox-weeks", "schedule": "0 3 * * *" }
  ```

- [ ] **Step 3: Full CI mirror + build.**
  Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build`
  Expected: all green. (`check:guardrails` must stay clean — `HyroxBoard` uses inline hex styles, not Tailwind chips, so `no-low-contrast-chip` does not apply; confirm.)

- [ ] **Step 4: Commit** (`HYROX-TC.3 — cron heartbeats migration + vercel schedules`).

---

## Self-review notes (author)

- **Spec coverage:** §6 publish cron + lead time (`LEAD_MS`) + safe degradation (no approved session → nothing pushed; try/catch per location) + revert (stale `cron:hyrox-publish` board → idle) (Task 4) ✓ · §7 purpose-built portrait `generated` board (Tasks 2-3) ✓ · §4.1 rolling expansion (Tasks 1,5) ✓.
- **Idempotency / no TV flicker:** publish only upserts when the target display isn't already showing that session (`already` check), so `pushed_at` doesn't churn every 5 min and the TV doesn't hard-reload needlessly. Session marked `published` once via `.eq('status','approved')` CAS.
- **Board authoritative on `hyrox_sessions.board`** (route re-fetches by `source_ref`), so a coach edit to an approved/published session reflects on the TV within one poll; no stale snapshot in `tv_content`.
- **"Which TV" (spec §6 open):** defaults to all active displays at the location; operator narrows via `locations.settings.hyrox.tv_display_ids`. Stillorgan has one display, so it works out of the box.
- **Prod gate:** the migration (heartbeat seed) is the only prod write — controller checkpoints before applying, then `get_advisors(security)` (expected: no change — it's a data insert, not DDL).
- **Deferred (post-Plan-03):** auto-tune signal computation (§8.3), second location, benchmark score capture, champ-app member view.
- **Verify-before-relying:** confirm the exact field names/return shape in `content/route.js` before editing (the map may drift); confirm `dublinDateKey` import path (`@/lib/dublin-time`); confirm `logWarn` signature in `@/lib/log`.
