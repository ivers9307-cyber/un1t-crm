'use client'

// FLOW-GRAPH Phase 2 (PR3) — the editable linear builder. Models the flow as an
// ordered list of nodes, rebuilds the graph on every change (toLinearGraph), and
// validates live with the same validateGraph the publish endpoint gates on.
// Save = PUT …/graph (draft); Publish = POST …/graph/publish (compile + replace
// steps). Branch authoring isn't here yet — branchy graphs render read-only.
import { useMemo, useState } from 'react'
import {
  Plus, ChevronUp, ChevronDown, Trash2, Pencil, Check, Save, Rocket,
  AlertTriangle, X,
} from 'lucide-react'
import { Button } from '@/components/ui'
import {
  validateGraph, toLinearGraph, linearOrder, nextNodeId, defaultConfigForType, describeNode,
} from '@/lib/sequences/graph'
import { styleForType, ADDABLE_TYPES } from './nodeStyles'
import { TriggerCard, Connector } from './parts'

const cloneNodes = (graph) => linearOrder(graph).map(n => ({ ...n, config: { ...(n.config || {}) } }))

export default function LinearFlowEditor({ initialGraph, sequence }) {
  const trigger = useMemo(() => initialGraph?.trigger || { type: 'manual', config: {} }, [initialGraph])
  const [nodes, setNodes] = useState(() => cloneNodes(initialGraph))
  const [expandedId, setExpandedId] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(null) // 'save' | 'publish' | null
  const [feedback, setFeedback] = useState(null) // { ok:boolean, text }
  const [issues, setIssues] = useState([]) // server publish issues
  const [paletteOpen, setPaletteOpen] = useState(false)

  const graph = useMemo(() => toLinearGraph(trigger, nodes), [trigger, nodes])
  const validation = useMemo(() => validateGraph(graph), [graph])
  const errorsByNode = useMemo(() => {
    const m = new Map()
    for (const e of validation.errors) {
      if (!e.nodeId) continue
      if (!m.has(e.nodeId)) m.set(e.nodeId, [])
      m.get(e.nodeId).push(e.message)
    }
    return m
  }, [validation])
  const generalErrors = validation.errors.filter(e => !e.nodeId)

  // --- mutations -----------------------------------------------------------
  const touch = () => { setDirty(true); setFeedback(null); setIssues([]) }
  const addStep = (type) => {
    const node = { id: nextNodeId(nodes), type, config: defaultConfigForType(type) }
    setNodes(prev => [...prev, node])
    setExpandedId(node.id)
    setPaletteOpen(false)
    touch()
  }
  const patchConfig = (id, patch) => {
    setNodes(prev => prev.map(n => (n.id === id ? { ...n, config: { ...n.config, ...patch } } : n)))
    touch()
  }
  const removeStep = (id) => {
    setNodes(prev => prev.filter(n => n.id !== id))
    if (expandedId === id) setExpandedId(null)
    touch()
  }
  const moveStep = (id, dir) => {
    setNodes(prev => {
      const i = prev.findIndex(n => n.id === id)
      const j = dir === 'up' ? i - 1 : i + 1
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const copy = [...prev]
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
    touch()
  }

  // --- persistence ---------------------------------------------------------
  const saveDraft = async () => {
    setBusy('save')
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/graph`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph }),
      })
      const data = await res.json()
      if (data.success) { setDirty(false); setFeedback({ ok: true, text: 'Draft saved' }) }
      else setFeedback({ ok: false, text: data.error || 'Could not save draft' })
    } catch {
      setFeedback({ ok: false, text: 'Network error saving draft' })
    } finally { setBusy(null) }
  }
  const publish = async () => {
    if (!validation.ok) { setFeedback({ ok: false, text: 'Fix the highlighted problems before publishing' }); return }
    setBusy('publish'); setIssues([])
    try {
      const res = await fetch(`/api/sequences/${sequence.id}/graph/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setDirty(false)
        setFeedback({ ok: true, text: `Published — ${data.steps} step${data.steps === 1 ? '' : 's'} live` })
      } else {
        setFeedback({ ok: false, text: data.error || 'Publish failed' })
        setIssues(Array.isArray(data.issues) ? data.issues : [])
      }
    } catch {
      setFeedback({ ok: false, text: 'Network error publishing' })
    } finally { setBusy(null) }
  }

  return (
    <div>
      {/* Action bar */}
      <div className="max-w-md mx-auto flex items-center gap-2 mb-4">
        <Button onClick={saveDraft} variant="secondary" size="sm" icon={Save}
          loading={busy === 'save'} disabled={!dirty || busy !== null}>
          Save draft
        </Button>
        <Button onClick={publish} variant="primary" size="sm" icon={Rocket}
          loading={busy === 'publish'} disabled={busy !== null || !validation.ok}>
          Publish
        </Button>
        <div className="ml-auto text-xs">
          {dirty && !feedback && <span className="text-un1t-subtle">Unsaved changes</span>}
          {feedback && (
            <span className={`flex items-center gap-1 ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
              {feedback.ok ? <Check size={13} /> : <AlertTriangle size={13} />}{feedback.text}
            </span>
          )}
        </div>
      </div>

      {/* Structural problems not tied to a single step (rare for a linear flow) */}
      {generalErrors.length > 0 && (
        <div className="max-w-md mx-auto mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.04] p-3">
          <ul className="text-xs text-rose-700 list-disc pl-4 space-y-0.5">
            {generalErrors.map((e, i) => <li key={i}>{e.message}</li>)}
          </ul>
        </div>
      )}

      {/* Server-side publish issues */}
      {issues.length > 0 && (
        <div className="max-w-md mx-auto mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.04] p-3">
          <p className="text-xs font-semibold text-rose-700 mb-1">Couldn’t publish:</p>
          <ul className="text-xs text-rose-700 list-disc pl-4 space-y-0.5">
            {issues.map((iss, i) => <li key={i}>{iss.message || String(iss)}</li>)}
          </ul>
        </div>
      )}

      <TriggerCard trigger={trigger} />

      {/* Steps */}
      {nodes.length === 0 ? (
        <p className="text-center text-sm text-un1t-subtle mt-6 mb-4">No steps yet — add the first action below.</p>
      ) : (
        nodes.map((node, i) => (
          <div key={node.id}>
            <Connector />
            <EditableNodeCard
              node={node}
              index={i}
              isFirst={i === 0}
              isLast={i === nodes.length - 1}
              expanded={expandedId === node.id}
              errors={errorsByNode.get(node.id) || []}
              onToggle={() => setExpandedId(expandedId === node.id ? null : node.id)}
              onMove={(dir) => moveStep(node.id, dir)}
              onRemove={() => removeStep(node.id)}
              onPatch={(patch) => patchConfig(node.id, patch)}
            />
          </div>
        ))
      )}

      {/* Add step */}
      <Connector />
      <div className="max-w-md mx-auto">
        {!paletteOpen ? (
          <button type="button" onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-un1t-border text-sm text-un1t-subtle hover:text-un1t-text hover:border-un1t-text/40 transition-colors">
            <Plus size={15} /> Add step
          </button>
        ) : (
          <div className="rounded-lg border border-un1t-border bg-un1t-surface p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-un1t-subtle uppercase tracking-wider">Add a step</p>
              <button type="button" onClick={() => setPaletteOpen(false)} className="text-un1t-subtle hover:text-un1t-text"><X size={14} /></button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {ADDABLE_TYPES.map(type => {
                const s = styleForType(type)
                const Icon = s.icon
                return (
                  <button key={type} type="button" onClick={() => addStep(type)}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-md border border-un1t-border hover:border-un1t-text/40 hover:bg-un1t-border/20 transition-colors text-left">
                    <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${s.chip}`}><Icon size={15} /></span>
                    <span className="text-xs text-un1t-text truncate">{s.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function EditableNodeCard({ node, isFirst, isLast, expanded, errors, onToggle, onMove, onRemove, onPatch }) {
  const s = styleForType(node.type)
  const Icon = s.icon
  const { typeLabel, summary } = describeNode(node)
  const hasErr = errors.length > 0
  return (
    <div className={`w-full max-w-md mx-auto bg-un1t-surface border rounded-lg shadow-sm ${hasErr ? 'border-rose-500/40' : 'border-un1t-border'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${s.chip}`}><Icon size={18} /></div>
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle">{typeLabel}</p>
          <p className="text-sm text-un1t-text truncate">{summary}</p>
        </button>
        <div className="flex items-center gap-0.5 shrink-0 text-un1t-subtle">
          <IconBtn label="Move up" disabled={isFirst} onClick={() => onMove('up')}><ChevronUp size={15} /></IconBtn>
          <IconBtn label="Move down" disabled={isLast} onClick={() => onMove('down')}><ChevronDown size={15} /></IconBtn>
          <IconBtn label={expanded ? 'Close' : 'Edit'} onClick={onToggle}><Pencil size={14} /></IconBtn>
          <IconBtn label="Delete" onClick={onRemove} danger><Trash2 size={14} /></IconBtn>
        </div>
      </div>
      {hasErr && !expanded && (
        <p className="px-4 pb-2 -mt-1 text-xs text-rose-700">{errors[0]}</p>
      )}
      {expanded && (
        <div className="border-t border-un1t-border px-4 py-3 space-y-3">
          <NodeConfig node={node} onPatch={onPatch} />
          {hasErr && (
            <ul className="text-xs text-rose-700 list-disc pl-4">
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function IconBtn({ children, label, onClick, disabled, danger }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${danger ? 'hover:bg-rose-500/10 hover:text-rose-700' : 'hover:bg-un1t-border/40 hover:text-un1t-text'}`}>
      {children}
    </button>
  )
}

// --- per-type config form -------------------------------------------------

function NodeConfig({ node, onPatch }) {
  const c = node.config || {}
  switch (node.type) {
    case 'email':
      return (
        <>
          <Labeled label="Subject"><Text value={c.subject} onChange={v => onPatch({ subject: v })} placeholder="Email subject" /></Labeled>
          <Labeled label="Body (HTML)" hint="Plain HTML. Use the classic editor for the rich designer.">
            <Area value={c.html_content} onChange={v => onPatch({ html_content: v })} rows={4} placeholder="<p>Hello {{first_name}}</p>" />
          </Labeled>
        </>
      )
    case 'whatsapp':
      return (
        <Labeled label="Template ID" hint="Approved WhatsApp template. Manage variables in the classic editor.">
          <Text value={c.template_id} onChange={v => onPatch({ template_id: v })} placeholder="template id" />
        </Labeled>
      )
    case 'sms':
      return (
        <Labeled label="Message" hint={`${(c.body || '').length} characters`}>
          <Area value={c.body} onChange={v => onPatch({ body: v })} rows={3} placeholder="SMS text — keep it short" />
        </Labeled>
      )
    case 'wait':
      return (
        <div className="grid grid-cols-3 gap-2">
          <Labeled label="Days"><Num value={c.days} onChange={v => onPatch({ days: v })} /></Labeled>
          <Labeled label="Hours"><Num value={c.hours} onChange={v => onPatch({ hours: v })} max={23} /></Labeled>
          <Labeled label="Minutes"><Num value={c.minutes} onChange={v => onPatch({ minutes: v })} max={59} /></Labeled>
        </div>
      )
    case 'apply_tag':
      return (
        <Labeled label="Tag to add"><Text value={c.tag} onChange={v => onPatch({ tag: v })} placeholder="e.g. vip" /></Labeled>
      )
    case 'update_field':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Labeled label="Field" hint="e.g. label"><Text value={c.field} onChange={v => onPatch({ field: v })} placeholder="field" /></Labeled>
          <Labeled label="Value"><Text value={c.value} onChange={v => onPatch({ value: v })} placeholder="value" /></Labeled>
        </div>
      )
    case 'internal_task':
      return (
        <>
          <Labeled label="Task subject"><Text value={c.subject} onChange={v => onPatch({ subject: v })} placeholder="Follow up with member" /></Labeled>
          <Labeled label="Note"><Area value={c.note} onChange={v => onPatch({ note: v })} rows={2} placeholder="Optional detail" /></Labeled>
          <Labeled label="Due in (minutes)" hint="Optional — leave blank for none">
            <Num value={c.due_offset_minutes} onChange={v => onPatch({ due_offset_minutes: v })} max={100000} />
          </Labeled>
        </>
      )
    case 'webhook':
      return (
        <>
          <Labeled label="URL" hint="Must be https://"><Text value={c.url} onChange={v => onPatch({ url: v })} placeholder="https://example.com/hook" /></Labeled>
          <Labeled label="Method">
            <Select value={c.method || 'POST'} onChange={v => onPatch({ method: v })} options={['POST', 'PUT', 'PATCH', 'GET', 'DELETE']} />
          </Labeled>
        </>
      )
    case 'move_pipeline_stage':
      return (
        <Labeled label="Move to stage" hint="Pipeline stage slug, e.g. active_member">
          <Text value={c.stage_slug} onChange={v => onPatch({ stage_slug: v })} placeholder="stage slug" />
        </Labeled>
      )
    default:
      return <p className="text-xs text-un1t-subtle">No editable settings.</p>
  }
}

// --- field primitives -----------------------------------------------------

const fieldCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

function Labeled({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-un1t-subtle mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-un1t-subtle/80 mt-1">{hint}</span>}
    </label>
  )
}
function Text({ value, onChange, placeholder }) {
  return <input type="text" className={fieldCls} value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
}
function Area({ value, onChange, placeholder, rows = 3 }) {
  return <textarea className={`${fieldCls} resize-y`} rows={rows} value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
}
function Num({ value, onChange, max = 365 }) {
  return (
    <input type="number" min={0} max={max} className={fieldCls} value={value ?? 0}
      onChange={e => onChange(e.target.value === '' ? 0 : Math.max(0, Math.min(max, parseInt(e.target.value, 10) || 0)))} />
  )
}
function Select({ value, onChange, options }) {
  return (
    <select className={fieldCls} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}
