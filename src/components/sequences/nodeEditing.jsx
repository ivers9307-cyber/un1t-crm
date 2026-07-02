'use client'

// FLOW-GRAPH Phase 2 — shared node-editing UI used by the recursive flow editor
// (FlowEditor): the editable node card, the icon button, and the per-type config
// form incl. the branch predicate. Field primitives live here too so any future
// editor reuses the exact same inputs.
import { ChevronUp, ChevronDown, Trash2, Pencil, AlertTriangle } from 'lucide-react'
import { describeNode } from '@/lib/sequences/graph'
import { isPhantomTag } from '@/lib/sequences/tag-vocabulary'
import { styleForType } from './nodeStyles'

export function IconBtn({ children, label, onClick, disabled, danger }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${danger ? 'hover:bg-rose-500/10 hover:text-rose-700' : 'hover:bg-un1t-border/40 hover:text-un1t-text'}`}>
      {children}
    </button>
  )
}

// A single editable step card (collapsed summary + expandable config). Branch
// nodes are rendered by FlowEditor itself (they own sub-lanes); this is for the
// header row of any node, with controls wired by the caller.
export function NodeCardHeader({ node, isFirst, isLast, expanded, onToggle, onMove, onRemove }) {
  const s = styleForType(node.type)
  const Icon = s.icon
  const { typeLabel, summary } = describeNode(node)
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${s.chip}`}><Icon size={18} /></div>
      <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle">{typeLabel}</p>
        <p className="text-sm text-un1t-text truncate">{summary}</p>
      </button>
      <div className="flex items-center gap-0.5 shrink-0 text-un1t-subtle">
        {onMove && <IconBtn label="Move up" disabled={isFirst} onClick={() => onMove('up')}><ChevronUp size={15} /></IconBtn>}
        {onMove && <IconBtn label="Move down" disabled={isLast} onClick={() => onMove('down')}><ChevronDown size={15} /></IconBtn>}
        <IconBtn label={expanded ? 'Close' : 'Edit'} onClick={onToggle}><Pencil size={14} /></IconBtn>
        <IconBtn label="Delete" onClick={onRemove} danger><Trash2 size={14} /></IconBtn>
      </div>
    </div>
  )
}

// Full step card (non-branch). Branch cards are assembled in FlowEditor.
export function EditableNodeCard({ node, isFirst, isLast, expanded, errors, onToggle, onMove, onRemove, onPatch, templates, tagVocabulary }) {
  const hasErr = errors.length > 0
  return (
    <div className={`w-72 bg-un1t-surface border rounded-lg shadow-sm ${hasErr ? 'border-rose-500/40' : 'border-un1t-border'}`}>
      <NodeCardHeader node={node} isFirst={isFirst} isLast={isLast} expanded={expanded} onToggle={onToggle} onMove={onMove} onRemove={onRemove} />
      {hasErr && !expanded && <p className="px-4 pb-2 -mt-1 text-xs text-rose-700">{errors[0]}</p>}
      {expanded && (
        <div className="border-t border-un1t-border px-4 py-3 space-y-3">
          <NodeConfig node={node} onPatch={onPatch} templates={templates} tagVocabulary={tagVocabulary} />
          {hasErr && <ul className="text-xs text-rose-700 list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </div>
      )}
    </div>
  )
}

// Pull {{1}}, {{2}}… placeholders out of a WhatsApp template's BODY component so
// we can render one input per variable (ported from the classic editor).
export function whatsappBodyVariables(template) {
  if (!template) return []
  const body = (template.components || []).find(c => c.type === 'BODY')
  if (!body?.text) return []
  const matches = body.text.match(/\{\{\d+\}\}/g) || []
  const set = new Set(matches.map(m => m.match(/\d+/)[0]))
  return [...set].sort((a, b) => Number(a) - Number(b))
}

export function NodeConfig({ node, onPatch, templates, tagVocabulary }) {
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
    case 'whatsapp': {
      const list = templates || []
      const selected = list.find(t => t.id === c.template_id)
      const vars = whatsappBodyVariables(selected)
      const curVars = c.variables || {}
      return (
        <>
          <Labeled label="Template" hint={list.length ? 'Approved WhatsApp templates at this location.' : 'No approved WhatsApp templates at this location yet.'}>
            <select className={fieldCls} value={c.template_id || ''} onChange={e => onPatch({ template_id: e.target.value || null, variables: {} })}>
              <option value="">Choose a template…</option>
              {list.map(t => <option key={t.id} value={t.id}>{t.name}{t.language ? ` (${t.language})` : ''}</option>)}
            </select>
          </Labeled>
          {selected && vars.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] text-un1t-subtle">Map each variable to a contact field (first_name / name / email / phone) or a literal value.</p>
              {vars.map(n => (
                <Labeled key={n} label={`Variable {{${n}}}`}>
                  <Text value={curVars[n]} onChange={v => onPatch({ variables: { ...curVars, [n]: v } })} placeholder="first_name or literal text" />
                </Labeled>
              ))}
            </div>
          )}
          {selected && vars.length === 0 && <p className="text-[11px] text-un1t-subtle">This template has no variables.</p>}
        </>
      )
    }
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
      return <Labeled label="Tag to add"><Text value={c.tag} onChange={v => onPatch({ tag: v })} placeholder="e.g. vip" /></Labeled>
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
          <Labeled label="Due in (minutes)" hint="Optional — leave blank for none"><Num value={c.due_offset_minutes} onChange={v => onPatch({ due_offset_minutes: v })} max={100000} /></Labeled>
        </>
      )
    case 'webhook':
      return (
        <>
          <Labeled label="URL" hint="Must be https://"><Text value={c.url} onChange={v => onPatch({ url: v })} placeholder="https://example.com/hook" /></Labeled>
          <Labeled label="Method"><Select value={c.method || 'POST'} onChange={v => onPatch({ method: v })} options={['POST', 'PUT', 'PATCH', 'GET', 'DELETE']} /></Labeled>
        </>
      )
    case 'move_pipeline_stage':
      return <Labeled label="Move to stage" hint="Pipeline stage slug, e.g. active_member"><Text value={c.stage_slug} onChange={v => onPatch({ stage_slug: v })} placeholder="stage slug" /></Labeled>
    case 'branch': {
      const p = c.predicate || {}
      const setPred = (patch) => onPatch({ predicate: { ...p, ...patch } })
      const ptype = p.type || 'has_tag'
      return (
        <>
          <Labeled label="Split the flow when…">
            <Select value={ptype} onChange={v => setPred({ type: v })}
              options={[['has_tag', 'Contact has a tag'], ['field_equals', 'Field equals a value'], ['field_in', 'Field is one of…']]} />
          </Labeled>
          {ptype === 'has_tag' && (
            <>
              <Labeled label="Tag"><Text value={p.tag} onChange={v => setPred({ tag: v })} placeholder="e.g. vip" /></Labeled>
              {/* SEQ-GLOFOX.2 — phantom-tag warning. Soft on purpose: tags
                  applied manually or by ANOTHER flow are legitimate, so this
                  never blocks publish — it catches typos and tags nothing
                  writes (a branch on one always takes the No path). */}
              {tagVocabulary && isPhantomTag(p.tag, tagVocabulary) && (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-700 leading-relaxed">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Nothing in this flow or the platform&apos;s built-in tags writes &ldquo;{String(p.tag).trim()}&rdquo; —
                    unless another flow or a staff member adds it, this branch will always take the No path.
                    Tip: the platform stamps <span className="font-mono">glofox_first_booking</span> on a
                    contact&apos;s first class booking.
                  </span>
                </p>
              )}
            </>
          )}
          {ptype === 'field_equals' && (
            <div className="grid grid-cols-2 gap-2">
              <Labeled label="Field"><Text value={p.field} onChange={v => setPred({ field: v })} placeholder="field" /></Labeled>
              <Labeled label="Equals"><Text value={p.value} onChange={v => setPred({ value: v })} placeholder="value" /></Labeled>
            </div>
          )}
          {ptype === 'field_in' && (
            <div className="grid grid-cols-2 gap-2">
              <Labeled label="Field"><Text value={p.field} onChange={v => setPred({ field: v })} placeholder="field" /></Labeled>
              <Labeled label="Is one of (comma-separated)">
                <Text value={(p.values || []).join(', ')} onChange={v => setPred({ values: v.split(',').map(s => s.trim()).filter(Boolean) })} placeholder="a, b, c" />
              </Labeled>
            </div>
          )}
        </>
      )
    }
    default:
      return <p className="text-xs text-un1t-subtle">No editable settings.</p>
  }
}

// --- field primitives -----------------------------------------------------

const fieldCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-subtle/60 focus:outline-none focus:ring-1 focus:ring-un1t-text/30'

export function Labeled({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-un1t-subtle mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-un1t-subtle/80 mt-1">{hint}</span>}
    </label>
  )
}
export function Text({ value, onChange, placeholder }) {
  return <input type="text" className={fieldCls} value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
}
export function Area({ value, onChange, placeholder, rows = 3 }) {
  return <textarea className={`${fieldCls} resize-y`} rows={rows} value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
}
export function Num({ value, onChange, max = 365 }) {
  return (
    <input type="number" min={0} max={max} className={fieldCls} value={value ?? 0}
      onChange={e => onChange(e.target.value === '' ? 0 : Math.max(0, Math.min(max, parseInt(e.target.value, 10) || 0)))} />
  )
}
// options: array of strings OR [value, label] pairs.
export function Select({ value, onChange, options }) {
  const norm = options.map(o => (Array.isArray(o) ? o : [o, o]))
  return (
    <select className={fieldCls} value={value} onChange={e => onChange(e.target.value)}>
      {norm.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}
