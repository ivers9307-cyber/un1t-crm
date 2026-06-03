'use client'

// FLOW-GRAPH Phase 2 (PR2) — the guided vertical-rail view of a sequence.
// Read-only preview: it renders the declarative graph (resolved server-side via
// resolveSequenceGraph, so legacy sequences are lazily decompiled) as a top-down
// rail where a branch forks into labelled YES / NO lanes — the headline upgrade
// over the old linear editor's "then_step_order: 3". Editing + Publish land in
// the next PR; for now the classic editor stays the edit surface.
import Link from 'next/link'
import {
  Mail, MessageCircle, MessageSquare, Hourglass, Tag, PencilLine,
  ClipboardList, Webhook, GitBranch, ArrowRightCircle, Zap, Pencil,
  CornerDownRight, CircleDot,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { buildFlowLayout, describeNode, describeTrigger } from '@/lib/sequences/graph/view'

// Per-type icon + light-theme tint. Class strings are literal so Tailwind keeps them.
const NODE_STYLES = {
  email: { icon: Mail, chip: 'bg-blue-500/10 text-blue-700' },
  whatsapp: { icon: MessageCircle, chip: 'bg-green-500/10 text-green-700' },
  sms: { icon: MessageSquare, chip: 'bg-cyan-500/10 text-cyan-700' },
  wait: { icon: Hourglass, chip: 'bg-un1t-border/50 text-un1t-subtle' },
  apply_tag: { icon: Tag, chip: 'bg-amber-500/10 text-amber-700' },
  update_field: { icon: PencilLine, chip: 'bg-indigo-500/10 text-indigo-700' },
  internal_task: { icon: ClipboardList, chip: 'bg-sky-500/10 text-sky-700' },
  webhook: { icon: Webhook, chip: 'bg-fuchsia-500/10 text-fuchsia-700' },
  branch: { icon: GitBranch, chip: 'bg-purple-500/10 text-purple-700' },
  move_pipeline_stage: { icon: ArrowRightCircle, chip: 'bg-emerald-500/10 text-emerald-700' },
}

const STATUS_BADGE = {
  draft: 'bg-un1t-border/40 text-un1t-subtle',
  active: 'bg-emerald-500/15 text-emerald-700',
  paused: 'bg-amber-500/15 text-amber-700',
}

function Connector() {
  return <div className="w-px h-5 bg-un1t-border mx-auto" aria-hidden />
}

function NodeCard({ node }) {
  const style = NODE_STYLES[node.type] || { icon: CircleDot, chip: 'bg-un1t-border/40 text-un1t-subtle' }
  const Icon = style.icon
  const { typeLabel, summary } = describeNode(node)
  return (
    <div className="w-full max-w-md mx-auto flex items-center gap-3 bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 shadow-sm">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${style.chip}`}>
        <Icon size={18} />
      </div>
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
      <CircleDot size={12} />
      <span>End of this path</span>
    </div>
  )
}

function RefCap() {
  return (
    <div className="flex items-center justify-center gap-1.5 text-un1t-subtle text-xs pt-1">
      <CornerDownRight size={12} />
      <span>Joins an earlier step</span>
    </div>
  )
}

function Lane({ label, tone, sub }) {
  const toneClass = tone === 'yes'
    ? 'border-emerald-500/30 bg-emerald-500/[0.03]'
    : 'border-rose-500/30 bg-rose-500/[0.03]'
  const pillClass = tone === 'yes' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-rose-500/15 text-rose-700'
  return (
    <div className={`rounded-xl border border-dashed ${toneClass} p-3`}>
      <div className="flex justify-center mb-2">
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${pillClass}`}>
          {label}
        </span>
      </div>
      <Rail layout={sub} />
    </div>
  )
}

// Recursive renderer over the layout tree from buildFlowLayout.
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
  // a plain node, then the rest of the chain
  return (
    <div className="flex flex-col items-stretch">
      <NodeCard node={layout.node} />
      {layout.next && layout.next.kind !== 'end' && <Connector />}
      {layout.next && layout.next.kind !== 'end' && <Rail layout={layout.next} />}
    </div>
  )
}

export default function SequenceFlowBuilder({ graph, sequence }) {
  const layout = buildFlowLayout(graph)
  const triggerLabel = describeTrigger(graph?.trigger)
  const status = sequence?.status || 'draft'
  const isEmpty = !layout || layout.kind === 'end'

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-1">
        <div className="min-w-0">
          <Link href="/communications/sequences" className="text-xs text-un1t-subtle hover:text-un1t-text">← All sequences</Link>
          <h1 className="text-xl font-semibold text-un1t-text truncate mt-1">{sequence?.name || 'Sequence'}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[status] || STATUS_BADGE.draft}`}>
            {status}
          </span>
          <Button as={Link} href={`/email/sequences/${sequence?.id}`} variant="secondary" size="sm" icon={Pencil}>
            Edit in classic editor
          </Button>
        </div>
      </div>

      <p className="text-xs text-un1t-subtle mb-5">
        New visual builder — read-only preview. Editing &amp; publish arrive next; use the classic editor to make changes for now.
      </p>

      {/* Trigger card */}
      <div className="w-full max-w-md mx-auto flex items-center gap-3 bg-un1t-text/[0.03] border border-un1t-border rounded-lg px-4 py-3">
        <div className="w-9 h-9 rounded-lg bg-un1t-text/10 text-un1t-text flex items-center justify-center shrink-0">
          <Zap size={18} />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle">Trigger</p>
          <p className="text-sm text-un1t-text truncate">{triggerLabel}</p>
        </div>
      </div>

      {/* The flow */}
      {isEmpty ? (
        <p className="text-center text-sm text-un1t-subtle mt-6">No steps yet — this sequence has no actions.</p>
      ) : (
        <div className="mt-0">
          <Connector />
          <Rail layout={layout} />
        </div>
      )}
    </div>
  )
}
