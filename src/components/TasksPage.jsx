'use client'

// TASKS.1 — Tasks tab (lightweight PM tool).
//
// Two views:
//   - List: vertical list, ordered by due date, grouped by status
//   - Board (default): kanban columns by status (todo, in_progress,
//     done, cancelled). Drag-drop between columns updates the row.
//
// Filters (apply in both views): assignee, project, priority.
// Free-text project tags are auto-discovered from existing rows.
//
// Source-of-truth: activities table, kind='task'. RLS already lets
// authenticated-in-location operators CRUD the location's rows
// (campaigns + activities share the same policy pattern), so all
// mutations go through the browser Supabase client directly. No
// /api/tasks layer needed for the UI itself.

import { useState, useMemo, useCallback, useEffect } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { dublinTodayStr } from '@/lib/dublin-time'
import Link from 'next/link'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  closestCenter,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Plus, Filter, LayoutList, LayoutGrid, X, Clock, User, AlertCircle,
  Circle, CircleDashed, CheckCircle2, MinusCircle, Flag,
} from 'lucide-react'

const STATUSES = [
  { key: 'todo',        label: 'To do',       Icon: CircleDashed,  bg: 'bg-un1t-border/40' },
  { key: 'in_progress', label: 'In progress', Icon: Circle,        bg: 'bg-blue-500/10' },
  { key: 'done',        label: 'Done',        Icon: CheckCircle2,  bg: 'bg-emerald-500/10' },
  { key: 'cancelled',   label: 'Cancelled',   Icon: MinusCircle,   bg: 'bg-un1t-border/40' },
]

const PRIORITIES = [
  { key: 'urgent', label: 'Urgent', cls: 'text-red-400' },
  { key: 'high',   label: 'High',   cls: 'text-orange-400' },
  { key: 'medium', label: 'Medium', cls: 'text-amber-300' },
  { key: 'low',    label: 'Low',    cls: 'text-un1t-subtle' },
]

export default function TasksPage({ initialTasks, locationId, profiles, projectsSeed }) {
  const db = createBrowserClient()
  const [tasks, setTasks] = useState(initialTasks || [])
  const [view, setView] = useState('board')   // 'board' | 'list'
  const [createOpen, setCreateOpen] = useState(false)
  const [filter, setFilter] = useState({ assignee: 'any', project: 'any', priority: 'any' })
  const [activeDragId, setActiveDragId] = useState(null)

  // Recompute the project pick-list from the current tasks set
  // (operator-created tags surface as filter options + autocomplete).
  const projects = useMemo(() => {
    const set = new Set(projectsSeed || [])
    for (const t of tasks) {
      if (t.project) set.add(t.project)
    }
    return Array.from(set).sort()
  }, [tasks, projectsSeed])

  // Apply filters.
  const visibleTasks = useMemo(() => {
    return tasks.filter(t => {
      if (filter.assignee !== 'any') {
        if (filter.assignee === 'unassigned' && t.assignee_id) return false
        if (filter.assignee !== 'unassigned' && t.assignee_id !== filter.assignee) return false
      }
      if (filter.project !== 'any') {
        if (filter.project === 'no_project' && t.project) return false
        if (filter.project !== 'no_project' && t.project !== filter.project) return false
      }
      if (filter.priority !== 'any' && t.priority !== filter.priority) return false
      return true
    })
  }, [tasks, filter])

  const byStatus = useMemo(() => {
    const m = { todo: [], in_progress: [], done: [], cancelled: [] }
    for (const t of visibleTasks) {
      const s = t.status || 'todo'
      if (m[s]) m[s].push(t)
    }
    return m
  }, [visibleTasks])

  const updateStatus = useCallback(async (taskId, newStatus) => {
    // Optimistic update — UI changes immediately, DB call follows.
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus, done: newStatus === 'done' } : t))
    const { error } = await db.from('activities')
      .update({ status: newStatus })
      .eq('id', taskId)
    if (error) {
      // Rollback on failure — pull the fresh row.
      const { data } = await db.from('activities').select('*').eq('id', taskId).single()
      if (data) setTasks(prev => prev.map(t => t.id === taskId ? data : t))
    }
  }, [db])

  const addTask = useCallback(async (payload) => {
    const insert = {
      kind: 'task',
      status: 'todo',
      location_id: locationId,
      source: 'manual',
      ...payload,
    }
    const { data, error } = await db.from('activities').insert(insert).select('*, contacts(id, name), profiles!activities_assignee_id_fkey(id, full_name)').single()
    if (error) throw new Error(error.message)
    setTasks(prev => [data, ...prev])
    return data
  }, [db, locationId])

  // Drag-drop handlers — only used in board view.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function onDragStart(e) { setActiveDragId(e.active.id) }
  function onDragEnd(e) {
    setActiveDragId(null)
    const { active, over } = e
    if (!over) return
    const taskId = active.id
    // over.id is either a task id (within same column) or a column id
    // when dropped on an empty area of a column. We only care about
    // cross-column moves, so resolve to a status.
    const dropTarget = over.id
    const targetStatus = STATUSES.find(s => s.key === dropTarget)?.key
      || tasks.find(t => t.id === dropTarget)?.status
    if (!targetStatus) return
    const current = tasks.find(t => t.id === taskId)
    if (!current || current.status === targetStatus) return
    updateStatus(taskId, targetStatus)
  }

  return (
    <div className="p-6">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-2xl font-bold">Tasks</h2>
        <div className="flex items-center gap-2">
          <ViewSwitcher value={view} onChange={setView} />
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-medium px-3 py-1.5 rounded-md hover:bg-un1t-accent"
          >
            <Plus size={14} /> New task
          </button>
        </div>
      </div>
      <p className="text-sm text-un1t-subtle mb-4">Manual follow-ups, calls, reminders, and project work.</p>

      <FiltersBar filter={filter} setFilter={setFilter} profiles={profiles} projects={projects} />

      {view === 'board' ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {STATUSES.map(col => (
              <Column key={col.key} status={col} tasks={byStatus[col.key]} />
            ))}
          </div>
          <DragOverlay>
            {activeDragId && (() => {
              const t = tasks.find(x => x.id === activeDragId)
              return t ? <TaskCard task={t} dragging /> : null
            })()}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="space-y-4">
          {STATUSES.map(col => byStatus[col.key].length > 0 && (
            <div key={col.key}>
              <h3 className="text-xs uppercase tracking-wide text-un1t-subtle mb-2 flex items-center gap-2">
                <col.Icon size={12} /> {col.label} <span className="text-un1t-muted">· {byStatus[col.key].length}</span>
              </h3>
              <div className="bg-un1t-surface border border-un1t-border rounded-lg divide-y divide-un1t-border">
                {byStatus[col.key].map(t => <TaskListRow key={t.id} task={t} onStatus={updateStatus} />)}
              </div>
            </div>
          ))}
          {visibleTasks.length === 0 && (
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-12 text-center text-sm text-un1t-muted">
              No tasks match these filters. Click <span className="text-un1t-subtle">New task</span> to add one.
            </div>
          )}
        </div>
      )}

      {createOpen && (
        <NewTaskModal
          onClose={() => setCreateOpen(false)}
          onCreate={addTask}
          profiles={profiles}
          projects={projects}
        />
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────

function ViewSwitcher({ value, onChange }) {
  return (
    <div className="inline-flex border border-un1t-border rounded-md overflow-hidden">
      {[
        { key: 'board', Icon: LayoutGrid, label: 'Board' },
        { key: 'list',  Icon: LayoutList, label: 'List' },
      ].map(({ key, Icon, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors ${
            value === key
              ? 'bg-un1t-border text-un1t-text'
              : 'text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/30'
          }`}
        >
          <Icon size={12} /> {label}
        </button>
      ))}
    </div>
  )
}

function FiltersBar({ filter, setFilter, profiles, projects }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
      <Filter size={12} className="text-un1t-subtle" />
      <SelectFilter
        value={filter.assignee}
        onChange={v => setFilter(f => ({ ...f, assignee: v }))}
        options={[
          { value: 'any', label: 'Anyone' },
          { value: 'unassigned', label: 'Unassigned' },
          ...(profiles || []).map(p => ({ value: p.id, label: p.full_name || p.email || p.id.slice(0, 8) })),
        ]}
      />
      <SelectFilter
        value={filter.project}
        onChange={v => setFilter(f => ({ ...f, project: v }))}
        options={[
          { value: 'any', label: 'Any project' },
          { value: 'no_project', label: 'No project' },
          ...projects.map(p => ({ value: p, label: p })),
        ]}
      />
      <SelectFilter
        value={filter.priority}
        onChange={v => setFilter(f => ({ ...f, priority: v }))}
        options={[
          { value: 'any', label: 'Any priority' },
          ...PRIORITIES.map(p => ({ value: p.key, label: p.label })),
        ]}
      />
      {(filter.assignee !== 'any' || filter.project !== 'any' || filter.priority !== 'any') && (
        <button
          onClick={() => setFilter({ assignee: 'any', project: 'any', priority: 'any' })}
          className="inline-flex items-center gap-1 text-un1t-subtle hover:text-un1t-text"
        >
          <X size={12} /> Clear
        </button>
      )}
    </div>
  )
}

function SelectFilter({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-un1t-surface border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text focus:outline-none focus:border-un1t-muted"
    >
      {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
    </select>
  )
}

function Column({ status, tasks }) {
  const { setNodeRef, isOver } = useDroppableColumn(status.key)
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border border-un1t-border ${status.bg} ${isOver ? 'ring-2 ring-un1t-text/40' : ''} flex flex-col min-h-[200px]`}
    >
      <div className="px-3 py-2 border-b border-un1t-border flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-un1t-subtle">
          <status.Icon size={12} /> {status.label}
        </div>
        <span className="text-[10px] text-un1t-muted">{tasks.length}</span>
      </div>
      <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
        <div className="p-2 space-y-2 flex-1">
          {tasks.map(t => <SortableTaskCard key={t.id} task={t} />)}
        </div>
      </SortableContext>
    </div>
  )
}

// useDroppable from @dnd-kit/core, but inlined to keep the import
// list small. (Re-exported via the same module.)
import { useDroppable } from '@dnd-kit/core'
function useDroppableColumn(id) { return useDroppable({ id }) }

function SortableTaskCard({ task }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard task={task} />
    </div>
  )
}

function TaskCard({ task, dragging }) {
  const isOverdue = task.due_date && task.status !== 'done' && task.status !== 'cancelled' && task.due_date < dublinTodayStr()
  return (
    <div className={`bg-un1t-bg border ${isOverdue ? 'border-red-500/30' : 'border-un1t-border'} rounded-md p-3 cursor-grab ${dragging ? 'shadow-lg' : ''}`}>
      <p className="text-sm text-un1t-text">{task.subject}</p>
      {task.note && <p className="text-xs text-un1t-muted mt-1 line-clamp-2">{task.note}</p>}
      <div className="flex items-center gap-2 mt-2 flex-wrap text-[10px]">
        {task.project && (
          <span className="px-1.5 py-0.5 rounded bg-un1t-border/60 text-un1t-subtle">{task.project}</span>
        )}
        {task.priority && (
          <span className={`inline-flex items-center gap-0.5 ${PRIORITIES.find(p => p.key === task.priority)?.cls || ''}`}>
            <Flag size={9} />
            {task.priority}
          </span>
        )}
        {task.due_date && (
          <span className={`inline-flex items-center gap-0.5 ${isOverdue ? 'text-red-400' : 'text-un1t-subtle'}`}>
            <Clock size={9} /> {task.due_date}{task.due_time ? ` ${task.due_time.slice(0,5)}` : ''}
          </span>
        )}
        {task.contacts && (
          <Link href={`/contacts/${task.contacts.id}`} className="inline-flex items-center gap-0.5 text-un1t-subtle hover:text-un1t-text" onClick={e => e.stopPropagation()}>
            <User size={9} /> {task.contacts.name}
          </Link>
        )}
      </div>
      {task.profiles && (
        <p className="text-[10px] text-un1t-muted mt-1.5">@ {task.profiles.full_name}</p>
      )}
    </div>
  )
}

function TaskListRow({ task, onStatus }) {
  return (
    <div className="flex items-start gap-3 p-3">
      <button
        onClick={() => onStatus(task.id, task.status === 'done' ? 'todo' : 'done')}
        className="mt-0.5 text-un1t-subtle hover:text-un1t-text"
        aria-label="Toggle done"
      >
        {task.status === 'done' ? <CheckCircle2 size={16} /> : <Circle size={16} />}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${task.status === 'done' ? 'line-through text-un1t-subtle' : 'text-un1t-text'}`}>{task.subject}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap text-[11px] text-un1t-subtle">
          {task.project && <span className="px-1.5 py-0.5 rounded bg-un1t-border/60">{task.project}</span>}
          {task.priority && (
            <span className={PRIORITIES.find(p => p.key === task.priority)?.cls || ''}>{task.priority}</span>
          )}
          {task.due_date && <span><Clock size={10} className="inline mr-1" />{task.due_date}</span>}
          {task.contacts && (
            <Link href={`/contacts/${task.contacts.id}`} className="hover:text-un1t-text">
              <User size={10} className="inline mr-1" />{task.contacts.name}
            </Link>
          )}
          {task.profiles && <span>@ {task.profiles.full_name}</span>}
        </div>
      </div>
    </div>
  )
}

function NewTaskModal({ onClose, onCreate, profiles, projects }) {
  const [subject, setSubject] = useState('')
  const [note, setNote] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [priority, setPriority] = useState('')
  const [project, setProject] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [dueTime, setDueTime] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function submit() {
    if (!subject.trim()) {
      setError('Subject is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate({
        subject: subject.trim(),
        note: note.trim() || null,
        assignee_id: assigneeId || null,
        priority: priority || null,
        project: project.trim() || null,
        due_date: dueDate || null,
        due_time: dueTime || null,
        type: 'task',
      })
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  // Close on Esc.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-surface border border-un1t-border rounded-lg w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">New task</h3>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text"><X size={16} /></button>
        </div>

        <label className="block text-xs text-un1t-subtle mb-1">Subject *</label>
        <input
          autoFocus
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="e.g. Follow up with Sarah re: trial"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted mb-3"
        />

        <label className="block text-xs text-un1t-subtle mb-1">Notes</label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={3}
          placeholder="Optional context"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted mb-3"
        />

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Assignee</label>
            <select
              value={assigneeId}
              onChange={e => setAssigneeId(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            >
              <option value="">Unassigned</option>
              {(profiles || []).map(p => (
                <option key={p.id} value={p.id}>{p.full_name || p.email || p.id.slice(0, 8)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Priority</label>
            <select
              value={priority}
              onChange={e => setPriority(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            >
              <option value="">None</option>
              {PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Due date</label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            />
          </div>
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Due time</label>
            <input
              type="time"
              value={dueTime}
              onChange={e => setDueTime(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            />
          </div>
        </div>

        <label className="block text-xs text-un1t-subtle mb-1">Project (free-text tag)</label>
        <input
          value={project}
          onChange={e => setProject(e.target.value)}
          placeholder="e.g. marketing, ops, product"
          list="task-project-suggestions"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted mb-3"
        />
        <datalist id="task-project-suggestions">
          {projects.map(p => <option key={p} value={p} />)}
        </datalist>

        {error && (
          <p className="text-xs text-red-400 mb-2 flex items-center gap-1">
            <AlertCircle size={12} /> {error}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onClose}
            className="text-sm text-un1t-subtle hover:text-un1t-text px-3 py-1.5 rounded-md"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving || !subject.trim()}
            className="text-sm bg-un1t-text text-un1t-bg font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  )
}
