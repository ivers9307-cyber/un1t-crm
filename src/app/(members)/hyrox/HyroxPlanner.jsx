'use client'

// HYROX-TC.2 — /admin/hyrox planner client. Mirrors TVAdmin.jsx's shape:
// props seed local state; createBrowserClient() re-reads after any mutation.
// All WRITES go through the service-role /api/hyrox/* routes (the tables
// are SELECT-only for browsers per the estate's route-skeleton rule) — this
// component never inserts/updates hyrox_blocks/hyrox_sessions directly.
//
// Renders:
//   - the "generate a block" form when there's no active block (canManage only)
//   - a weeks x slots grid of the active block's sessions, status-chipped
//   - a review drawer (Modal) for one session: full_session + board, with
//     editable focus + station values, approve / send-back-to-draft / regenerate
//   - a per-week "approve all drafts" batch action
// Deep-links from the approvals inbox (?focus=<sessionId>) auto-open the drawer.

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Dumbbell, AlertCircle, Check, RotateCcw, RefreshCw, ChevronRight, X, Plus, Star, Tv, Cast } from 'lucide-react'
import { Button, Modal, Field, Table } from '@/components/ui'
import { DIFFICULTY_DIALS, MAX_STORED_EXAMPLE_CHARS } from '@/lib/hyrox/constants'
import HyroxBoard from '@/components/HyroxBoard'

const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
]

const DIAL_LABELS = {
  beginner_heavy: 'Beginner-heavy',
  mixed: 'Mixed',
  competitive: 'Competitive',
}

// Light-theme chip recipe (CLAUDE.md / check:guardrails): bg-<c>-500/10
// text-<c>-700. draft=amber, approved=green, published=blue.
const STATUS_CHIP = {
  draft: 'bg-amber-500/10 text-amber-700',
  approved: 'bg-green-500/10 text-green-700',
  published: 'bg-blue-500/10 text-blue-700',
}

function StatusChip({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full text-[11px] font-medium px-2 py-0.5 capitalize ${STATUS_CHIP[status] || 'bg-un1t-border text-un1t-subtle'}`}>
      {status}
    </span>
  )
}

export default function HyroxPlanner({ initialBlock, initialSessions, initialSettings, locationId, canManage, nextUpId = null }) {
  const db = createBrowserClient()
  const searchParams = useSearchParams()

  const [block, setBlock] = useState(initialBlock)
  const [sessions, setSessions] = useState(initialSessions || [])
  const [error, setError] = useState(null)

  // ── House style & examples panel ────────────────────────────────────
  const [houseStyle, setHouseStyle] = useState(initialSettings?.houseStyle || '')
  const [settingsCharter, setSettingsCharter] = useState(initialSettings?.charter || '')
  const [examples, setExamples] = useState(initialSettings?.styleExamples || [])
  const [addingExample, setAddingExample] = useState(false)
  const [newExampleLabel, setNewExampleLabel] = useState('')
  const [newExampleText, setNewExampleText] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [settingsError, setSettingsError] = useState(null)

  function addExample() {
    if (!newExampleText.trim()) return
    setExamples((rows) => [
      ...rows,
      {
        id: crypto.randomUUID(),
        source: 'pasted',
        label: newExampleLabel.trim() || undefined,
        text: newExampleText.trim(),
        added_at: new Date().toISOString(),
      },
    ])
    setNewExampleLabel('')
    setNewExampleText('')
    setAddingExample(false)
  }

  function removeExample(index) {
    setExamples((rows) => rows.filter((_, i) => i !== index))
  }

  async function handleSaveSettings() {
    setSavingSettings(true)
    setSettingsError(null)
    setSettingsSaved(false)
    try {
      const res = await fetch('/api/hyrox/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          charter: settingsCharter,
          house_style: houseStyle,
          style_examples: examples,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error((json.error || 'Failed to save settings.') + (Array.isArray(json.issues) && json.issues.length ? ': ' + json.issues.map((i) => i.message || (i.path || []).join('.')).join('; ') : ''))
      setSettingsSaved(true)
    } catch (err) {
      setSettingsError(err.message)
    } finally {
      setSavingSettings(false)
    }
  }

  const refresh = useCallback(async () => {
    const { data: freshBlock } = await db
      .from('hyrox_blocks')
      .select('*')
      .eq('location_id', locationId)
      .eq('status', 'active')
      .order('starts_on', { ascending: false })
      .limit(1)
      .maybeSingle()
    setBlock(freshBlock || null)
    if (freshBlock) {
      const { data: freshSessions } = await db
        .from('hyrox_sessions')
        .select('*')
        .eq('block_id', freshBlock.id)
        .order('week_no', { ascending: true })
        .order('slot', { ascending: true })
      setSessions(freshSessions || [])
    } else {
      setSessions([])
    }
  }, [db, locationId])

  // ── Generate-a-block form ────────────────────────────────────────────
  const [genForm, setGenForm] = useState({
    starts_on: '',
    session_weekdays: [3, 7], // default Wed + Sun
    difficulty_dial: 'mixed',
    auto_tune_enabled: false,
    charter: '',
    expand_weeks: 2,
  })
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState(null)
  const [expandProgress, setExpandProgress] = useState(null)
  const [expandingWeek, setExpandingWeek] = useState(null)
  const [regenOpen, setRegenOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  function toggleWeekday(day) {
    setGenForm((f) => ({
      ...f,
      session_weekdays: f.session_weekdays.includes(day)
        ? f.session_weekdays.filter((d) => d !== day)
        : [...f.session_weekdays, day].sort((a, b) => a - b),
    }))
  }

  async function handleGenerate(e) {
    e.preventDefault()
    setGenError(null)
    if (!genForm.starts_on) { setGenError('Pick a start date.'); return }
    if (!genForm.session_weekdays.length) { setGenError('Pick at least one session day.'); return }
    setGenerating(true)
    try {
      const res = await fetch('/api/hyrox/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          starts_on: genForm.starts_on,
          session_weekdays: genForm.session_weekdays,
          difficulty_dial: genForm.difficulty_dial,
          auto_tune_enabled: genForm.auto_tune_enabled,
          ...(genForm.charter.trim() ? { charter: genForm.charter.trim() } : {}),
          expand_weeks: genForm.expand_weeks,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to generate the block.')
      const newBlock = json.data?.block
      setBlock(newBlock || null)
      setSessions([])
      // The block exists immediately. Now fill the first weeks one bounded
      // request at a time (each is its own short job, so nothing times out);
      // sessions appear in the grid as they land.
      if (newBlock) {
        const target = Math.min(genForm.expand_weeks || 2, newBlock.weeks || 12)
        for (let w = 1; w <= target; w += 1) {
          setExpandProgress(`Generating week ${w} of ${target}…`)
          try {
            await callExpand(newBlock.id, w)
          } catch (err) {
            setError(`Week ${w}: ${err.message}`)
          }
          await refresh()
        }
        setExpandProgress(null)
      }
    } catch (err) {
      setGenError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  async function callExpand(blockId, weekNo) {
    const res = await fetch(`/api/hyrox/blocks/${blockId}/expand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ week_no: weekNo }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.success) throw new Error(json.error || 'generation failed')
    return json.data
  }

  async function expandWeek(blockId, weekNo) {
    setExpandingWeek(weekNo)
    setError(null)
    try {
      await callExpand(blockId, weekNo)
      await refresh()
    } catch (err) {
      setError(`Week ${weekNo}: ${err.message}`)
    } finally {
      setExpandingWeek(null)
    }
  }

  // ── Weeks x slots grid ────────────────────────────────────────────────
  const sessionMap = useMemo(() => {
    const m = new Map()
    for (const s of sessions) m.set(`${s.week_no}:${s.slot}`, s)
    return m
  }, [sessions])

  const weekRows = block ? Array.from({ length: block.weeks }, (_, i) => i + 1) : []
  const slotCols = block ? Array.from({ length: block.sessions_per_week }, (_, i) => i + 1) : []

  async function generateRemaining() {
    setError(null)
    // Any week missing ANY of its slots — this fills partial weeks too, not just
    // untouched ones, so a week that failed halfway gets its gap filled.
    const weeksToDo = weekRows.filter((w) => !slotCols.every((slot) => sessionMap.has(`${w}:${slot}`)))
    for (let i = 0; i < weeksToDo.length; i += 1) {
      const w = weeksToDo[i]
      setExpandProgress(`Generating week ${w} (${i + 1} of ${weeksToDo.length})…`)
      try { await callExpand(block.id, w) } catch (err) { setError(`Week ${w}: ${err.message}`) }
      await refresh()
    }
    setExpandProgress(null)
  }

  // Start the whole block over: a fresh arc + wipe of every non-published
  // session (the route keeps published ones live). Destructive, so confirm-gated.
  async function handleRegenerateBlock() {
    if (!block) return
    setRegenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/hyrox/blocks/${block.id}/regenerate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to regenerate the block.')
      setRegenOpen(false)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setRegenerating(false)
    }
  }

  const [batchApprovingWeek, setBatchApprovingWeek] = useState(null)

  async function approveWeek(weekNo) {
    const drafts = sessions.filter((s) => s.week_no === weekNo && s.status === 'draft')
    if (!drafts.length) return
    setBatchApprovingWeek(weekNo)
    setError(null)
    try {
      const results = await Promise.all(drafts.map((s) => fetch(`/api/hyrox/sessions/${s.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      })))
      if (results.some((r) => !r.ok)) setError('Some sessions in that week failed to approve — open them individually to check.')
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBatchApprovingWeek(null)
    }
  }

  // ── Review drawer ─────────────────────────────────────────────────────
  const [focusedId, setFocusedId] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const focusedSession = useMemo(() => sessions.find((s) => s.id === focusedId) || null, [sessions, focusedId])
  const [editFocus, setEditFocus] = useState('')
  const [editStations, setEditStations] = useState([])
  const [sessionBusy, setSessionBusy] = useState(null)
  const [drawerError, setDrawerError] = useState(null)
  const [exemplarNote, setExemplarNote] = useState(null)
  const [pushNote, setPushNote] = useState(null)

  // Auto-open from the approvals-inbox deep link (?focus=<id>).
  useEffect(() => {
    const f = searchParams.get('focus')
    if (f) setFocusedId(f)
  }, [searchParams])

  // Seed the editable fields whenever the drawer opens on a (new) session.
  useEffect(() => {
    if (!focusedId) return
    const s = sessions.find((x) => x.id === focusedId)
    if (!s) return
    setEditFocus(s.focus || '')
    setEditStations(Array.isArray(s.board?.stations) ? s.board.stations.map((st) => ({ ...st, target: st.target ?? st.performance ?? st.elite ?? '' })) : [])
    setDrawerError(null)
    setExemplarNote(null)
    setPushNote(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId])

  function closeDrawer() {
    setFocusedId(null)
    setPreviewOpen(false)
    setDrawerError(null)
    setExemplarNote(null)
    setPushNote(null)
  }

  function updateStation(index, field, value) {
    setEditStations((rows) => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
  }

  async function submitSession(statusOverride) {
    if (!focusedSession) return
    setSessionBusy(statusOverride || 'save')
    setDrawerError(null)
    try {
      const body = {
        focus: editFocus,
        board: { ...focusedSession.board, stations: editStations },
      }
      if (statusOverride) body.status = statusOverride
      const res = await fetch(`/api/hyrox/sessions/${focusedSession.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Save failed.')
      await refresh()
    } catch (err) {
      setDrawerError(err.message)
    } finally {
      setSessionBusy(null)
    }
  }

  async function handleRegenerate() {
    if (!focusedSession) return
    setSessionBusy('regenerate')
    setDrawerError(null)
    try {
      const res = await fetch(`/api/hyrox/sessions/${focusedSession.id}/regenerate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Regeneration failed.')
      await refresh()
      setEditFocus(json.data?.focus || '')
      setEditStations(Array.isArray(json.data?.board?.stations) ? json.data.board.stations.map((st) => ({ ...st, target: st.target ?? st.performance ?? st.elite ?? '' })) : [])
    } catch (err) {
      setDrawerError(err.message)
    } finally {
      setSessionBusy(null)
    }
  }

  async function handleSaveExample() {
    if (!focusedSession) return
    setSessionBusy('exemplar')
    setDrawerError(null)
    setExemplarNote(null)
    try {
      const res = await fetch(`/api/hyrox/sessions/${focusedSession.id}/exemplar`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to save example.')
      setExemplarNote(json.data?.added ? 'Saved as example' : 'Already saved')
    } catch (err) {
      setDrawerError(err.message)
    } finally {
      setSessionBusy(null)
    }
  }

  async function handlePushToTv() {
    if (!focusedSession) return
    setSessionBusy('push')
    setDrawerError(null)
    setPushNote(null)
    try {
      const res = await fetch(`/api/hyrox/sessions/${focusedSession.id}/push`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to push to the TV.')
      const n = json.data?.pushed || 1
      setPushNote(`Live on the TV (${n} screen${n === 1 ? '' : 's'})`)
    } catch (err) {
      setDrawerError(err.message)
    } finally {
      setSessionBusy(null)
    }
  }

  const isPublished = focusedSession?.status === 'published'
  const canPush = focusedSession?.board && (focusedSession?.status === 'approved' || focusedSession?.status === 'published')

  const stationRows = editStations.map((st, i) => ({ ...st, _i: i }))
  const stationColumns = [
    { key: 'name', header: 'Station', accessor: 'name' },
    {
      key: 'target',
      header: 'Target',
      render: (row) => (
        <input
          type="text"
          value={row.target ?? row.performance ?? ''}
          disabled={isPublished}
          onChange={(e) => updateStation(row._i, 'target', e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded px-2 py-1 text-xs text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
        />
      ),
    },
  ]

  // A week is "remaining" if it is missing ANY slot (empty OR partially failed).
  const remainingWeeks = weekRows.filter((w) => !slotCols.every((slot) => sessionMap.has(`${w}:${slot}`)))

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <Dumbbell size={20} className="text-un1t-subtle" />
          <h2 className="text-2xl font-bold">Hyrox Training Club</h2>
        </div>
        {block && canManage && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={RotateCcw}
            disabled={Boolean(expandProgress) || generating || regenerating}
            onClick={() => setRegenOpen(true)}
          >
            Regenerate block
          </Button>
        )}
      </div>

      {block ? (
        <p className="text-sm text-un1t-subtle mb-5">
          {block.title || 'Active block'} · {block.weeks} weeks · {block.sessions_per_week}/week · starts {block.starts_on} · {DIAL_LABELS[block.difficulty_dial] || block.difficulty_dial}
          {block.auto_tune_enabled ? ' · auto-tune on' : ''}
        </p>
      ) : (
        <p className="text-sm text-un1t-subtle mb-5">
          No active block for this studio yet.{canManage ? ' Generate one below to start coach review.' : ' Ask a manager to generate one.'}
        </p>
      )}

      {block && canManage && remainingWeeks.length > 0 && (
        <div className="mb-5">
          <Button
            type="button"
            icon={Dumbbell}
            loading={Boolean(expandProgress)}
            disabled={Boolean(expandProgress) || generating}
            onClick={generateRemaining}
          >
            Generate remaining weeks ({remainingWeeks.length})
          </Button>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {expandProgress && (
        <div className="mb-4 flex items-center gap-2 text-xs text-un1t-subtle bg-un1t-surface border border-un1t-border rounded-md px-3 py-2">
          <RefreshCw size={12} className="animate-spin" /> {expandProgress}
        </div>
      )}

      {canManage && (
        <details className="bg-un1t-surface border border-un1t-border rounded-lg mb-6 group">
          <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-un1t-text">House style &amp; examples</div>
              <div className="text-xs text-un1t-subtle mt-0.5">
                Teach the generator how this studio actually runs its classes.
              </div>
            </div>
            <ChevronRight size={14} className="text-un1t-subtle transition-transform group-open:rotate-90 shrink-0" />
          </summary>

          <div className="border-t border-un1t-border p-5 space-y-4">
            <Field
              id="hyrox-house-style"
              label="House style"
              hint="How you run your classes: structure, cue language, favoured formats, equipment, terminology, do's and don'ts."
            >
              {(props) => (
                <textarea
                  {...props}
                  rows={5}
                  maxLength={8000}
                  value={houseStyle}
                  onChange={(e) => setHouseStyle(e.target.value)}
                  placeholder="e.g. Partner relays most weeks, loud counted cueing, always finish with a team effort."
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                />
              )}
            </Field>

            <Field
              id="hyrox-settings-charter"
              label="Charter"
              hint="The hard design rules every session is self-checked against. Blank uses the default charter."
            >
              {(props) => (
                <textarea
                  {...props}
                  rows={6}
                  maxLength={8000}
                  value={settingsCharter}
                  onChange={(e) => setSettingsCharter(e.target.value)}
                  placeholder="Leave blank to use the default charter."
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                />
              )}
            </Field>

            <div>
              <span className="block text-sm font-medium text-un1t-text mb-1">Example sessions</span>
              {examples.length === 0 ? (
                <p className="text-xs text-un1t-subtle mb-2">
                  No saved examples yet. Add one below, or use &quot;Save as style example&quot; on a session in the review drawer.
                </p>
              ) : (
                <ul className="divide-y divide-un1t-border/40 border border-un1t-border rounded-md mb-2">
                  {examples.map((ex, i) => (
                    <li key={ex.id || i} className="flex items-start justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-un1t-text truncate">{ex.label || 'Example'}</p>
                        <p className="text-xs text-un1t-subtle line-clamp-2">
                          {ex.text.length > 160 ? `${ex.text.slice(0, 160)}…` : ex.text}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeExample(i)}
                        aria-label="Remove example"
                        className="text-un1t-muted hover:text-red-700 shrink-0"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {addingExample ? (
                <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
                  <input
                    type="text"
                    value={newExampleLabel}
                    onChange={(e) => setNewExampleLabel(e.target.value)}
                    placeholder="Label (e.g. Wed engine session)"
                    className="w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                  />
                  <textarea
                    rows={4}
                    maxLength={MAX_STORED_EXAMPLE_CHARS}
                    value={newExampleText}
                    onChange={(e) => setNewExampleText(e.target.value)}
                    placeholder="Paste the session text."
                    className="w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                  />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="secondary" disabled={!newExampleText.trim()} onClick={addExample}>
                      Add
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => { setAddingExample(false); setNewExampleLabel(''); setNewExampleText('') }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="button" size="sm" variant="ghost" icon={Plus} onClick={() => setAddingExample(true)}>
                  Add example
                </Button>
              )}
            </div>

            {settingsError && (
              <div className="flex items-center gap-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                <AlertCircle size={12} /> {settingsError}
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <Button type="button" loading={savingSettings} onClick={handleSaveSettings}>
                Save
              </Button>
              {settingsSaved && (
                <span className="text-xs text-green-700 inline-flex items-center gap-1">
                  <Check size={12} /> Saved
                </span>
              )}
            </div>
          </div>
        </details>
      )}

      {!block && canManage && (
        <form onSubmit={handleGenerate} className="bg-un1t-surface border border-un1t-border rounded-lg p-5 max-w-xl mb-8">
          <h3 className="text-sm font-semibold text-un1t-text mb-3">Generate a 12-week block</h3>

          <Field id="hyrox-starts-on" label="Start date (week 1 Monday)" className="mb-3">
            {(props) => (
              <input
                {...props}
                type="date"
                value={genForm.starts_on}
                onChange={(e) => setGenForm((f) => ({ ...f, starts_on: e.target.value }))}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
            )}
          </Field>

          <div className="mb-3">
            <span className="block text-sm font-medium text-un1t-text mb-1">Session days</span>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_OPTIONS.map((d) => {
                const active = genForm.session_weekdays.includes(d.value)
                return (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => toggleWeekday(d.value)}
                    className={`text-xs px-2.5 py-1 rounded-md border ${active ? 'bg-un1t-text text-un1t-bg border-un1t-text' : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'}`}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
          </div>

          <Field id="hyrox-dial" label="Difficulty dial" className="mb-3">
            {(props) => (
              <select
                {...props}
                value={genForm.difficulty_dial}
                onChange={(e) => setGenForm((f) => ({ ...f, difficulty_dial: e.target.value }))}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              >
                {DIFFICULTY_DIALS.map((d) => (
                  <option key={d} value={d}>{DIAL_LABELS[d] || d}</option>
                ))}
              </select>
            )}
          </Field>

          <label className="flex items-center gap-2 text-sm text-un1t-subtle mb-3">
            <input
              type="checkbox"
              checked={genForm.auto_tune_enabled}
              onChange={(e) => setGenForm((f) => ({ ...f, auto_tune_enabled: e.target.checked }))}
            />
            Auto-tune from the performance signal (once available)
          </label>

          <Field id="hyrox-charter" label="Charter override (optional)" hint="Blank uses the default workout-design charter." className="mb-3">
            {(props) => (
              <textarea
                {...props}
                rows={4}
                value={genForm.charter}
                onChange={(e) => setGenForm((f) => ({ ...f, charter: e.target.value }))}
                placeholder="Leave blank to use the default charter."
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              />
            )}
          </Field>

          <Field id="hyrox-expand-weeks" label="Weeks to generate up front" className="mb-4">
            {(props) => (
              <input
                {...props}
                type="number"
                min={1}
                max={12}
                value={genForm.expand_weeks}
                onChange={(e) => setGenForm((f) => ({ ...f, expand_weeks: Math.max(1, Math.min(12, Number(e.target.value) || 1)) }))}
                className="w-32 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
            )}
          </Field>

          {genError && (
            <p className="text-xs text-red-700 mb-3 flex items-center gap-1"><AlertCircle size={12} /> {genError}</p>
          )}

          <Button type="submit" loading={generating}>
            {generating ? 'Generating…' : 'Generate block'}
          </Button>
        </form>
      )}

      {block && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm mb-6">
            <thead>
              <tr className="border-b border-un1t-border text-left text-xs uppercase tracking-wide text-un1t-muted">
                <th className="py-2 px-3 font-medium">Week</th>
                {slotCols.map((slot) => (
                  <th key={slot} className="py-2 px-3 font-medium">Session {slot}</th>
                ))}
                <th className="py-2 px-3 font-medium text-right">Batch</th>
              </tr>
            </thead>
            <tbody>
              {weekRows.map((week) => {
                const weekDrafts = sessions.filter((s) => s.week_no === week && s.status === 'draft')
                const weekComplete = slotCols.every((slot) => sessionMap.has(`${week}:${slot}`))
                const weekPartial = !weekComplete && slotCols.some((slot) => sessionMap.has(`${week}:${slot}`))
                return (
                  <tr key={week} className="border-b border-un1t-border/60">
                    <td className="py-2 px-3 text-un1t-text font-medium">{week}</td>
                    {slotCols.map((slot) => {
                      const s = sessionMap.get(`${week}:${slot}`)
                      const isNextUp = s && s.id === nextUpId
                      return (
                        <td key={slot} className="py-2 px-3 align-top">
                          {s ? (
                            <button
                              type="button"
                              onClick={() => setFocusedId(s.id)}
                              className={`text-left rounded-md px-2 py-1.5 -mx-2 w-full ${isNextUp ? 'bg-amber-500/10 ring-1 ring-amber-500/40' : 'hover:bg-un1t-surface'}`}
                            >
                              <span className="flex items-center gap-1.5">
                                <StatusChip status={s.status} />
                                {isNextUp && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Next up</span>}
                                <ChevronRight size={12} className="text-un1t-muted" />
                              </span>
                              <span className="block text-xs text-un1t-subtle mt-0.5 truncate max-w-[180px]">{s.focus || '—'}</span>
                            </button>
                          ) : (
                            <span className="text-xs text-un1t-muted italic">not generated yet</span>
                          )}
                        </td>
                      )
                    })}
                    <td className="py-2 px-3 text-right align-top">
                      <div className="flex flex-col items-end gap-1">
                        {!weekComplete && canManage && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            icon={Dumbbell}
                            loading={expandingWeek === week}
                            disabled={Boolean(expandProgress) || generating}
                            onClick={() => expandWeek(block.id, week)}
                          >
                            {weekPartial ? 'Finish week' : 'Generate'}
                          </Button>
                        )}
                        {weekDrafts.length > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            icon={Check}
                            loading={batchApprovingWeek === week}
                            onClick={() => approveWeek(week)}
                          >
                            Approve all ({weekDrafts.length})
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {focusedSession && (
        <Modal
          open
          onClose={closeDrawer}
          size="xl"
          title={`Week ${focusedSession.week_no} · session ${focusedSession.slot}${focusedSession.is_benchmark ? ' · benchmark' : ''}`}
          footer={
            <>
              {canManage && focusedSession.full_session?.main && (
                <span className="inline-flex items-center gap-2">
                  <Button type="button" variant="secondary" icon={Star} loading={sessionBusy === 'exemplar'} onClick={handleSaveExample}>
                    Save as style example
                  </Button>
                  {exemplarNote && (
                    <span className="text-xs text-green-700 inline-flex items-center gap-1">
                      <Check size={12} /> {exemplarNote}
                    </span>
                  )}
                </span>
              )}
              {focusedSession.board && (
                <Button type="button" variant="secondary" icon={Tv} onClick={() => setPreviewOpen(true)}>
                  Preview on TV
                </Button>
              )}
              {canPush && (
                <span className="inline-flex items-center gap-2">
                  <Button type="button" variant="secondary" icon={Cast} loading={sessionBusy === 'push'} onClick={handlePushToTv}>
                    Push to TV
                  </Button>
                  {pushNote && (
                    <span className="text-xs text-green-700 inline-flex items-center gap-1"><Check size={12} /> {pushNote}</span>
                  )}
                </span>
              )}
              <Button type="button" variant="secondary" onClick={closeDrawer}>Close</Button>
              {!isPublished && (
                <Button type="button" variant="secondary" icon={RefreshCw} loading={sessionBusy === 'regenerate'} onClick={handleRegenerate}>
                  Regenerate
                </Button>
              )}
              {!isPublished && (
                <Button type="button" variant="secondary" loading={sessionBusy === 'save'} onClick={() => submitSession()}>
                  Save changes
                </Button>
              )}
              {!isPublished && focusedSession.status === 'approved' && (
                <Button type="button" variant="secondary" icon={RotateCcw} loading={sessionBusy === 'draft'} onClick={() => submitSession('draft')}>
                  Send back to draft
                </Button>
              )}
              {!isPublished && focusedSession.status !== 'approved' && (
                <Button type="button" icon={Check} loading={sessionBusy === 'approved'} onClick={() => submitSession('approved')}>
                  Approve
                </Button>
              )}
            </>
          }
        >
          <div className="flex items-center gap-2 mb-3">
            <StatusChip status={focusedSession.status} />
            <span className="text-xs text-un1t-muted capitalize">{focusedSession.phase} phase</span>
          </div>

          {drawerError && (
            <div className="mb-3 flex items-center gap-2 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
              <AlertCircle size={12} /> {drawerError}
            </div>
          )}

          <Field id="hyrox-session-focus" label="Focus" className="mb-4">
            {(props) => (
              <input
                {...props}
                type="text"
                value={editFocus}
                disabled={isPublished}
                onChange={(e) => setEditFocus(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
              />
            )}
          </Field>

          <div className="grid sm:grid-cols-2 gap-4 mb-4">
            <div>
              <h4 className="text-xs uppercase tracking-wide text-un1t-muted mb-2">Coach session</h4>
              <dl className="space-y-2 text-sm">
                {focusedSession.full_session?.strength && (
                  <div>
                    <dt className="text-xs text-un1t-subtle">Strength</dt>
                    <dd className="text-un1t-text whitespace-pre-wrap">{focusedSession.full_session.strength}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-un1t-subtle">Main</dt>
                  <dd className="text-un1t-text whitespace-pre-wrap">{focusedSession.full_session?.main || '—'}</dd>
                </div>
                {focusedSession.full_session?.finisher && (
                  <div>
                    <dt className="text-xs text-un1t-subtle">Finisher</dt>
                    <dd className="text-un1t-text whitespace-pre-wrap">{focusedSession.full_session.finisher}</dd>
                  </div>
                )}
                {Array.isArray(focusedSession.full_session?.cues) && focusedSession.full_session.cues.length > 0 && (
                  <div>
                    <dt className="text-xs text-un1t-subtle">Cues</dt>
                    <dd>
                      <ul className="list-disc list-inside text-un1t-text">
                        {focusedSession.full_session.cues.map((c, i) => <li key={i}>{c}</li>)}
                      </ul>
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-un1t-subtle">Why</dt>
                  <dd className="text-un1t-text whitespace-pre-wrap">{focusedSession.full_session?.why || '—'}</dd>
                </div>
              </dl>
            </div>

            <div>
              <h4 className="text-xs uppercase tracking-wide text-un1t-muted mb-2">TV board</h4>
              <dl className="space-y-1.5 text-sm mb-3">
                <div className="flex justify-between"><dt className="text-un1t-subtle">Format</dt><dd className="text-un1t-text">{focusedSession.board?.format || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-un1t-subtle">Cap</dt><dd className="text-un1t-text">{focusedSession.board?.cap_minutes ? `${focusedSession.board.cap_minutes} min` : '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-un1t-subtle">Target</dt><dd className="text-un1t-text">{focusedSession.board?.target || '—'}</dd></div>
              </dl>
              <Table
                columns={stationColumns}
                rows={stationRows}
                rowKey={(row) => row._i}
                empty="No stations."
              />
            </div>
          </div>
        </Modal>
      )}

      {regenOpen && (
        <Modal
          open
          onClose={() => { if (!regenerating) setRegenOpen(false) }}
          size="md"
          title="Regenerate this block?"
          footer={
            <>
              <Button type="button" variant="secondary" disabled={regenerating} onClick={() => setRegenOpen(false)}>
                Cancel
              </Button>
              <Button type="button" variant="danger" icon={RotateCcw} loading={regenerating} onClick={handleRegenerateBlock}>
                Regenerate block
              </Button>
            </>
          }
        >
          <p className="text-sm text-un1t-text">
            This designs a brand new 12-week plan and deletes every draft and approved session in this block.
            Published sessions that may be live on a TV are kept. This cannot be undone.
          </p>
          <p className="text-sm text-un1t-subtle mt-2">
            When it finishes, use &quot;Generate remaining weeks&quot; to write the new sessions.
          </p>
        </Modal>
      )}

      {previewOpen && focusedSession?.board && (
        <div
          role="dialog"
          aria-label="TV board preview"
          onClick={() => setPreviewOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.86)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px' }}
        >
          {/* Portrait frame with container-type:size so the board's cqh/cqw units
              resolve exactly as they do on the TV stage. */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'relative', height: 'min(86vh, 880px)', aspectRatio: '9 / 16', containerType: 'size', background: '#0b0b0d', borderRadius: '14px', overflow: 'hidden', outline: '1px solid #232329', boxShadow: '0 30px 70px -30px rgba(0,0,0,0.9)' }}
          >
            <HyroxBoard board={focusedSession.board} />
          </div>
          <button type="button" onClick={() => setPreviewOpen(false)} className="text-xs text-white/70 hover:text-white">
            Close preview (this is exactly what the TV shows)
          </button>
        </div>
      )}
    </div>
  )
}
