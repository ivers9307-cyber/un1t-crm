'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button, Card } from '@/components/ui'

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
  if (!board.baseline_at) return 'On — first placement tonight, no messages'
  return 'On'
}

function Chip({ chip }) {
  return <span className={`text-xs px-2 py-0.5 rounded-full ${chip.tone}`}>{chip.label}</span>
}

function BoardCard({ board }) {
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
            <Chip chip={followupChip(board.followups, st.id)} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default function BoardList({ locationId }) {
  const [state, setState] = useState({ loading: true, error: null, boards: [], canEdit: false })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/locations/${locationId}/pipelines`)
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || 'Could not load pipelines')
        if (!cancelled) setState({ loading: false, error: null, boards: json.data.boards || [], canEdit: !!json.data.can_edit })
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e.message, boards: [], canEdit: false })
      }
    }
    load()
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
      {offers.length === 0 && <p className="text-sm text-un1t-subtle">No offer boards yet.</p>}
      {offers.map((b) => <BoardCard key={b.id} board={b} />)}
      {builtIn.map((b) => <BoardCard key={b.id} board={b} />)}
    </div>
  )
}
