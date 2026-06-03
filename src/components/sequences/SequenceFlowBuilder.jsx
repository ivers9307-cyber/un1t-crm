'use client'

// FLOW-GRAPH Phase 2 — the sequence builder. Dispatches on graph shape:
//   - pure tree (linear OR branched) → FlowEditor (editable: add / branch /
//     reorder / delete + per-type config + save draft + publish)
//   - re-convergent (paths merge back) → the read-only guided rail with YES/NO
//     lanes; edit those in the classic editor. Either way classic stays available.
import Link from 'next/link'
import { Pencil, CircleDot, CornerDownRight, GitBranch } from 'lucide-react'
import { Button } from '@/components/ui'
import { buildFlowLayout, describeNode, isPureTree } from '@/lib/sequences/graph'
import { styleForType } from './nodeStyles'
import { TriggerCard, Connector } from './parts'
import FlowEditor from './FlowEditor'
import SequenceSettings from './SequenceSettings'

const STATUS_BADGE = {
  draft: 'bg-un1t-border/40 text-un1t-subtle',
  active: 'bg-emerald-500/15 text-emerald-700',
  paused: 'bg-amber-500/15 text-amber-700',
}

function NodeCard({ node }) {
  const s = styleForType(node.type)
  const Icon = s.icon
  const { typeLabel, summary } = describeNode(node)
  return (
    <div className="w-full max-w-md mx-auto flex items-center gap-3 bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 shadow-sm">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${s.chip}`}><Icon size={18} /></div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle">{typeLabel}</p>
        <p className="text-sm text-un1t-text truncate">{summary}</p>
      </div>
    </div>
  )
}

function EndCap() {
  return (
    <div className="flex items-center justify-center gap-1.5 text-un1t-subtle text-xs pt-1">
      <CircleDot size={12} /><span>End of this path</span>
    </div>
  )
}
function RefCap() {
  return (
    <div className="flex items-center justify-center gap-1.5 text-un1t-subtle text-xs pt-1">
      <CornerDownRight size={12} /><span>Joins an earlier step</span>
    </div>
  )
}

function Lane({ label, tone, sub }) {
  const toneClass = tone === 'yes' ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-rose-500/30 bg-rose-500/[0.03]'
  const pillClass = tone === 'yes' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-rose-500/15 text-rose-700'
  return (
    <div className={`rounded-xl border border-dashed ${toneClass} p-3`}>
      <div className="flex justify-center mb-2">
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${pillClass}`}>{label}</span>
      </div>
      <Rail layout={sub} />
    </div>
  )
}

function Rail({ layout }) {
  if (!layout || layout.kind === 'end') return <EndCap />
  if (layout.kind === 'ref') return <RefCap />
  if (layout.kind === 'branch') {
    return (
      <div className="flex flex-col items-stretch">
        <NodeCard node={layout.node} />
        <Connector />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Lane label="Yes" tone="yes" sub={layout.yes} />
          <Lane label="No" tone="no" sub={layout.no} />
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-stretch">
      <NodeCard node={layout.node} />
      {layout.next && layout.next.kind !== 'end' && <Connector />}
      {layout.next && layout.next.kind !== 'end' && <Rail layout={layout.next} />}
    </div>
  )
}

function ReadOnlyFlow({ graph }) {
  const layout = buildFlowLayout(graph)
  const isEmpty = !layout || layout.kind === 'end'
  return (
    <>
      <div className="max-w-md mx-auto mb-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-700 flex items-center gap-2">
        <GitBranch size={14} className="shrink-0" />
        This flow’s paths merge back together — a shape the visual editor can’t edit yet. Use the classic editor to change it.
      </div>
      <TriggerCard trigger={graph?.trigger} />
      {isEmpty ? (
        <p className="text-center text-sm text-un1t-subtle mt-6">No steps yet.</p>
      ) : (
        <div><Connector /><Rail layout={layout} /></div>
      )}
    </>
  )
}

export default function SequenceFlowBuilder({ graph, sequence }) {
  const editable = isPureTree(graph)
  const status = sequence?.status || 'draft'

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <div className="min-w-0">
          <Link href="/communications/sequences" className="text-xs text-un1t-subtle hover:text-un1t-text">← All sequences</Link>
          <h1 className="text-xl font-semibold text-un1t-text truncate mt-1">{sequence?.name || 'Sequence'}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[status] || STATUS_BADGE.draft}`}>{status}</span>
          <Button as={Link} href={`/email/sequences/${sequence?.id}`} variant="secondary" size="sm" icon={Pencil}>
            Classic editor
          </Button>
        </div>
      </div>
      <p className="text-xs text-un1t-subtle mb-5">
        Visual flow builder — add steps, branch into yes/no paths, reorder, and publish. Editing the trigger still lives in the classic editor for now.
      </p>

      <SequenceSettings sequence={sequence} />

      {editable
        ? <FlowEditor initialGraph={graph} sequence={sequence} />
        : <ReadOnlyFlow graph={graph} />}
    </div>
  )
}
