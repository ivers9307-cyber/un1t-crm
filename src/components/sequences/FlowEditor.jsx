'use client'

// FLOW-GRAPH Phase 2 (PR3b) — the recursive flow editor. Handles any PURE TREE
// (linear OR branched). The flow is a tree of lanes; a branch item forks into an
// editable yes-lane and no-lane (nestable). Edits run on the tree, which
// compiles back to the graph (treeToGraph) and validates live with the same
// validateGraph the publish endpoint gates on. Re-convergent graphs aren't trees
// and stay read-only (SequenceFlowBuilder decides).
import { useEffect, useMemo, useState } from 'react'
import { Plus, Check, Save, Rocket, AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui'
import {
  validateGraph, treeToGraph, graphToTree, flattenTreeIds, nextNodeId, defaultConfigForType,
} from '@/lib/sequences/graph'
import { styleForType, ADDABLE_TYPES } from './nodeStyles'
import { TriggerCard, Connector } from './parts'
import { EditableNodeCard } from './nodeEditing'

const PALETTE = [...ADDABLE_TYPES, 'branch']

const cloneLane = (lane) => (lane || []).map(it => it.type === 'branch'
  ? { ...it, config: { ...it.config, predicate: { ...(it.config?.predicate || {}) } }, yes: cloneLane(it.yes), no: cloneLane(it.no) }
  : { ...it, config: { ...(it.config || {}) } })

// Replace the lane at `path` (array of {i, lane:'yes'|'no'}) with fn(lane). Pure.
function updateLaneAt(tree, path, fn) {
  if (path.length === 0) return fn(tree)
  const [head, ...rest] = path
  return tree.map((item, idx) => idx === head.i ? { ...item, [head.lane]: updateLaneAt(item[head.lane] || [], rest, fn) } : item)
}

export default function FlowEditor({ initialGraph, sequence }) {
  const trigger = useMemo(() => initialGraph?.trigger || { type: 'manual', config: {} }, [initialGraph])
  const [tree, setTree] = useState(() => cloneLane(graphToTree(initialGraph).tree || []))
  const [expandedId, setExpandedId] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [issues, setIssues] = useState([])
  const [templates, setTemplates] = useState([])

  // Approved WhatsApp templates for this location, for the whatsapp-node picker.
  useEffect(() => {
    const loc = sequence?.location_id
    if (!loc) return
    let active = true
    fetch(`/api/whatsapp/templates?location_id=${loc}&status=APPROVED`)
      .then(r => r.json())
      .then(d => { if (active && d?.success) setTemplates(d.templates || []) })
      .catch(() => {})
    return () => { active = false }
  }, [sequence?.location_id])

  const graph = useMemo(() => treeToGraph(trigger, tree), [trigger, tree])
  const validation = useMemo(() => validateGraph(graph), [graph])
  const errorsByNode = useMemo(() => {
    const m = new Map()
    for (const e of validation.errors) { if (!e.nodeId) continue; if (!m.has(e.nodeId)) m.set(e.nodeId, []); m.get(e.nodeId).push(e.message) }
    return m
  }, [validation])
  const generalErrors = validation.errors.filter(e => !e.nodeId)

  const touch = () => { setDirty(true); setFeedback(null); setIssues([]) }
  const add = (lanePath, type) => {
    const id = nextNodeId(flattenTreeIds(tree).map(x => ({ id: x })))
    const item = type === 'branch'
      ? { id, type: 'branch', config: { predicate: { type: 'has_tag', tag: '' } }, yes: [], no: [] }
      : { id, type, config: defaultConfigForType(type) }
    setTree(prev => updateLaneAt(prev, lanePath, lane => [...lane, item])); setExpandedId(id); touch()
  }
  const patch = (lanePath, i, p) => { setTree(prev => updateLaneAt(prev, lanePath, lane => lane.map((it, idx) => idx === i ? { ...it, config: { ...it.config, ...p } } : it))); touch() }
  const remove = (lanePath, i) => { setTree(prev => updateLaneAt(prev, lanePath, lane => lane.filter((_, idx) => idx !== i))); touch() }
  const move = (lanePath, i, dir) => {
    setTree(prev => updateLaneAt(prev, lanePath, lane => {
      const j = dir === 'up' ? i - 1 : i + 1
      if (j < 0 || j >= lane.length || lane[j].type === 'branch') return lane
      const copy = [...lane]; [copy[i], copy[j]] = [copy[j], copy[i]]; return copy
    })); touch()
  }
  const toggle = (id) => setExpandedId(prev => prev === id ? null : id)
  const ctx = { expandedId, errorsByNode, add, patch, remove, move, toggle, templates }

  const saveDraft = async () => {
    setBusy('save')
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/graph`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph }) })
      const data = await res.json()
      if (data.success) { setDirty(false); setFeedback({ ok: true, text: 'Draft saved' }) } else setFeedback({ ok: false, text: data.error || 'Could not save draft' })
    } catch { setFeedback({ ok: false, text: 'Network error saving draft' }) } finally { setBusy(null) }
  }
  const publish = async () => {
    if (!validation.ok) { setFeedback({ ok: false, text: 'Fix the highlighted problems before publishing' }); return }
    setBusy('publish'); setIssues([])
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/graph/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph }) })
      const data = await res.json()
      if (res.ok && data.success) { setDirty(false); setFeedback({ ok: true, text: `Published — ${data.steps} step${data.steps === 1 ? '' : 's'} live` }) }
      else { setFeedback({ ok: false, text: data.error || 'Publish failed' }); setIssues(Array.isArray(data.issues) ? data.issues : []) }
    } catch { setFeedback({ ok: false, text: 'Network error publishing' }) } finally { setBusy(null) }
  }

  return (
    <div>
      <div className="max-w-md mx-auto flex items-center gap-2 mb-4">
        <Button onClick={saveDraft} variant="secondary" size="sm" icon={Save} loading={busy === 'save'} disabled={!dirty || busy !== null}>Save draft</Button>
        <Button onClick={publish} variant="primary" size="sm" icon={Rocket} loading={busy === 'publish'} disabled={busy !== null || !validation.ok}>Publish</Button>
        <div className="ml-auto text-xs">
          {dirty && !feedback && <span className="text-un1t-subtle">Unsaved changes</span>}
          {feedback && <span className={`flex items-center gap-1 ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{feedback.ok ? <Check size={13} /> : <AlertTriangle size={13} />}{feedback.text}</span>}
        </div>
      </div>

      {generalErrors.length > 0 && (
        <div className="max-w-md mx-auto mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.04] p-3">
          <ul className="text-xs text-rose-700 list-disc pl-4 space-y-0.5">{generalErrors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
        </div>
      )}
      {issues.length > 0 && (
        <div className="max-w-md mx-auto mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.04] p-3">
          <p className="text-xs font-semibold text-rose-700 mb-1">Couldn’t publish:</p>
          <ul className="text-xs text-rose-700 list-disc pl-4 space-y-0.5">{issues.map((iss, i) => <li key={i}>{iss.message || String(iss)}</li>)}</ul>
        </div>
      )}

      <TriggerCard trigger={trigger} />
      <LaneView lane={tree} lanePath={[]} ctx={ctx} />
    </div>
  )
}

function LaneView({ lane, lanePath, ctx }) {
  const endsInBranch = lane.length > 0 && lane[lane.length - 1].type === 'branch'
  return (
    <div className="flex flex-col items-stretch">
      {lane.map((item, i) => {
        const nextIsBranch = lane[i + 1] && lane[i + 1].type === 'branch'
        return (
          <div key={item.id}>
            <Connector />
            {item.type === 'branch'
              ? <BranchBlock item={item} lanePath={lanePath} index={i} ctx={ctx} />
              : <EditableNodeCard
                  node={item} isFirst={i === 0} isLast={i === lane.length - 1 || nextIsBranch}
                  expanded={ctx.expandedId === item.id} errors={ctx.errorsByNode.get(item.id) || []}
                  onToggle={() => ctx.toggle(item.id)} onMove={(dir) => ctx.move(lanePath, i, dir)}
                  onRemove={() => ctx.remove(lanePath, i)} onPatch={(p) => ctx.patch(lanePath, i, p)}
                  templates={ctx.templates} />}
          </div>
        )
      })}
      {!endsInBranch && (<><Connector /><AddAffordance lanePath={lanePath} ctx={ctx} /></>)}
    </div>
  )
}

function BranchBlock({ item, lanePath, index, ctx }) {
  return (
    <div className="flex flex-col items-stretch">
      <EditableNodeCard
        node={item} expanded={ctx.expandedId === item.id} errors={ctx.errorsByNode.get(item.id) || []}
        onToggle={() => ctx.toggle(item.id)} onRemove={() => ctx.remove(lanePath, index)} onPatch={(p) => ctx.patch(lanePath, index, p)} />
      <Connector />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <LaneFrame label="Yes" tone="yes"><LaneView lane={item.yes} lanePath={[...lanePath, { i: index, lane: 'yes' }]} ctx={ctx} /></LaneFrame>
        <LaneFrame label="No" tone="no"><LaneView lane={item.no} lanePath={[...lanePath, { i: index, lane: 'no' }]} ctx={ctx} /></LaneFrame>
      </div>
    </div>
  )
}

function LaneFrame({ label, tone, children }) {
  const toneClass = tone === 'yes' ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-rose-500/30 bg-rose-500/[0.03]'
  const pillClass = tone === 'yes' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-rose-500/15 text-rose-700'
  return (
    <div className={`rounded-xl border border-dashed ${toneClass} p-3`}>
      <div className="flex justify-center"><span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${pillClass}`}>{label}</span></div>
      {children}
    </div>
  )
}

function AddAffordance({ lanePath, ctx }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full max-w-md mx-auto flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-un1t-border text-sm text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/40 transition-colors">
        <Plus size={15} /> Add step
      </button>
    )
  }
  return (
    <div className="w-full max-w-md mx-auto rounded-lg border border-un1t-border bg-un1t-surface p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-un1t-subtle uppercase tracking-wider">Add a step</p>
        <button type="button" onClick={() => setOpen(false)} className="text-un1t-subtle hover:text-un1t-text"><X size={14} /></button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PALETTE.map(type => {
          const s = styleForType(type); const Icon = s.icon
          return (
            <button key={type} type="button" onClick={() => { ctx.add(lanePath, type); setOpen(false) }} className="flex items-center gap-2 px-2.5 py-2 rounded-md border border-un1t-border hover:border-un1t-text/40 hover:bg-un1t-border/20 transition-colors text-left">
              <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${s.chip}`}><Icon size={15} /></span>
              <span className="text-xs text-un1t-text truncate">{s.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
