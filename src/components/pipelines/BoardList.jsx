'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button, Card } from '@/components/ui'
import { RECIPES } from '@shared/pipelines/recipes.js'

// Follow-up state -> chip. Several rows can exist for a stage (a rejected one
// kept beside its replacement), so the most current one wins.
const CHIPS = {
  live: { label: 'Live', tone: 'bg-green-500/10 text-green-700' },
  awaiting_approval: { label: 'Waiting for Meta', tone: 'bg-amber-500/10 text-amber-700' },
  rejected: { label: 'Rejected', tone: 'bg-red-500/10 text-red-700' },
  draft: { label: 'Off', tone: 'bg-gray-500/10 text-gray-700' },
  off: { label: 'Off', tone: 'bg-gray-500/10 text-gray-700' },
}
const NONE_CHIP = { label: 'None', tone: 'bg-gray-500/10 text-gray-700' }
const PRECEDENCE = ['live', 'awaiting_approval', 'draft', 'rejected', 'off']

export function followupChip(followups, stageId) {
  const rows = (followups || []).filter((f) => f.stage_id === stageId)
  if (rows.length === 0) return NONE_CHIP
  // An unknown state ranks last, never first (indexOf gives -1).
  const rank = (st) => { const i = PRECEDENCE.indexOf(st); return i === -1 ? PRECEDENCE.length : i }
  const best = [...rows].sort((a, b) => rank(a.state) - rank(b.state))[0]
  return CHIPS[best.state] || NONE_CHIP
}

export function boardStatus(board) {
  if (!board.enabled) return 'Off'
  // A built-in board has no baseline_at (it never went through the builder's
  // silent switch-on) and has been placing people and sending all along.
  if (!board.board_type) return 'On'
  if (!board.baseline_at) return 'On — first placement tonight, no messages'
  return 'On'
}

function Chip({ chip }) {
  return <span className={`text-xs px-2 py-0.5 rounded-full ${chip.tone}`}>{chip.label}</span>
}

// PIPEBUILD.5p — a built-in board's follow-ups are hand-built sequences, which
// pipeline_stage_followups never holds, so its chips come from the
// stage-coverage read (the strip on the board). No coverage for the board (a
// failed read, or a board that is off) shows no chip: never a false "None".
const SEQ_CHIP = { tone: 'bg-green-500/10 text-green-700' }
export function builtInChip(coverageStages, stageId) {
  if (!coverageStages) return null
  const st = coverageStages.find((s) => s.id === stageId)
  if (!st) return null
  const n = (st.followups || []).length
  if (n === 0) return NONE_CHIP
  return { ...SEQ_CHIP, label: `${n} sequence${n === 1 ? '' : 's'}` }
}

function BoardCard({ board, coverageStages }) {
  const builtIn = !board.board_type
  const stages = [...(board.stages || [])].sort((a, b) => a.display_order - b.display_order)
  return (
    <Card>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-un1t-text">{board.name}</h3>
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-700">
          {builtIn ? 'Built in' : 'Offer'}
        </span>
        <span className="text-sm text-un1t-subtle">{boardStatus(board)}</span>
        {!builtIn && <span className="text-sm text-un1t-subtle">Priority {board.priority}</span>}
        {!builtIn && (
          <Link href={`/settings/pipelines/${board.id}`} className="ml-auto text-sm text-un1t-accent">
            Open
          </Link>
        )}
      </div>
      {builtIn && <p className="text-xs text-un1t-subtle mt-1">Built in code — read only</p>}
      <ul className="mt-3 space-y-1">
        {stages.map((st) => (
          <li key={st.id} className="flex items-center gap-2 text-sm text-un1t-text">
            <span>{st.name}</span>
            {builtIn
              ? (builtInChip(coverageStages, st.id) && <Chip chip={builtInChip(coverageStages, st.id)} />)
              : <Chip chip={followupChip(board.followups, st.id)} />}
          </li>
        ))}
      </ul>
    </Card>
  )
}

const NO_WHATSAPP_NOTICE = "This studio has no WhatsApp number switched on yet. You can build the board now; its follow-ups can't be submitted until a number is on."

// PIPEBUILD.6-5 — a studio with no offer boards starts from a recipe.
function RecipeCards({ hasWhatsapp }) {
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold text-un1t-text">Start from a recipe</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {Object.values(RECIPES).map((r) => (
          <Card key={r.key}>
            <h3 className="text-sm font-semibold text-un1t-text">{r.name}</h3>
            <p className="text-sm text-un1t-subtle mt-1">{r.description}</p>
            {hasWhatsapp === false && <p className="text-xs text-amber-700 mt-2">{NO_WHATSAPP_NOTICE}</p>}
            <Link href={`/settings/pipelines/new?recipe=${encodeURIComponent(r.key)}`} className="inline-block mt-2 text-sm text-un1t-accent">
              Set up
            </Link>
          </Card>
        ))}
      </div>
    </div>
  )
}

export default function BoardList({ locationId }) {
  const [state, setState] = useState({ loading: true, error: null, boards: [], canEdit: false, hasWhatsapp: null })
  const [coverage, setCoverage] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/locations/${locationId}/pipelines`)
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || 'Could not load pipelines')
        if (!cancelled) setState({ loading: false, error: null, boards: json.data.boards || [], canEdit: !!json.data.can_edit, hasWhatsapp: json.data.has_whatsapp ?? null })
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e.message, boards: [], canEdit: false, hasWhatsapp: null })
      }
    }
    async function loadCoverage() {
      try {
        const res = await fetch(`/api/locations/${locationId}/stage-coverage`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok || !json.success) return
        const byBoard = Object.fromEntries((json.data?.boards || []).map((b) => [b.id, b.stages || []]))
        if (!cancelled) setCoverage(byBoard)
      } catch {
        // Decoration: built-in boards then show no chips.
      }
    }
    load()
    loadCoverage()
    return () => { cancelled = true }
  }, [locationId])

  if (state.loading) return <p className="text-sm text-un1t-subtle">Loading…</p>
  if (state.error) return <p className="text-sm text-red-700">{state.error}</p>

  const builtIn = state.boards.filter((b) => !b.board_type)
  const offers = state.boards.filter((b) => b.board_type)

  return (
    <div className="space-y-4">
      {state.canEdit && (
        <div>
          <Button as={Link} href="/settings/pipelines/new">New board</Button>
        </div>
      )}
      {state.canEdit && offers.length === 0 && <RecipeCards hasWhatsapp={state.hasWhatsapp} />}
      {offers.length === 0 && <p className="text-sm text-un1t-subtle">No offer boards yet.</p>}
      {offers.map((b) => <BoardCard key={b.id} board={b} />)}
      {builtIn.map((b) => <BoardCard key={b.id} board={b} coverageStages={coverage?.[b.id] || null} />)}
    </div>
  )
}
