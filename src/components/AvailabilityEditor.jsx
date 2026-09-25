'use client'

// AVAIL.1 — "My availability". A coach says when they CANNOT work: weekly
// times (a day and a window, or the whole day) and dates (a day or a range,
// all day or a window, with a note). Everything else counts as available.
// No approval; the managers at every studio the coach belongs to get one
// notification per save. The rules and the words for what is wrong are
// shared/availability.js's, the same the server applies (PUT
// /api/schedule/availability re-checks everything; this only says it sooner).
//
// A dated rule that has already started (AVAIL.1a's contract,
// carryStartedRules): only its last day and its note can change, or it can be
// removed. The row is sent back with its STORED start; the server keeps the
// days already gone as history and carries the rule on from today. The client
// judges every row with the same knownKeys the route does, so a new or moved
// rule starting before today is refused here, not only after a round trip.

import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import {
  AVAILABILITY_WEEKDAYS, AVAILABILITY_WEEKDAY_LABELS, AVAILABILITY_LIMITS, normaliseRule, ruleProblem,
  carryStartedRules,
} from '@shared/availability'
import { readJson } from './schedule/useScheduleData'
import { rowToPayload, planSave, placeIssues } from '@/lib/availability-editor-model'

// A stable React key per row: rules have no id in the own GET's shape, and
// an index key would move a half-typed note onto the wrong row on Remove.
let keySeq = 0
const nextKey = () => ++keySeq

function toRow(rule, todayIso) {
  return {
    key: nextKey(),
    kind: rule.kind,
    // The stored start of a dated rule that began before today (the row can
    // no longer move it), else null. YYYY-MM-DD strings order as dates.
    startedOn: rule.kind === 'dated' && rule.start_date && rule.start_date < todayIso ? rule.start_date : null,
    weekday: rule.weekday || 'mon',
    start_date: rule.start_date || '',
    end_date: rule.end_date || '',
    all_day: rule.all_day === true,
    start_time: rule.start_time || '',
    end_time: rule.end_time || '',
    note: rule.note || '',
  }
}
const rowsFrom = (data, todayIso) => [...(data?.weekly || []), ...(data?.dated || [])].map((r) => toRow(r, todayIso))
// The stored dated rules that started before today: carryStartedRules'
// `stored`, exactly what the route reads back before it judges a save.
const startedFrom = (data, todayIso) => (data?.dated || []).map(normaliseRule).filter((r) => r && r.start_date < todayIso)

function rowProblem(row, todayIso, stored) {
  const rule = normaliseRule({ ...rowToPayload(row), kind: row.kind })
  if (row.kind !== 'dated') return ruleProblem(rule, { todayIso })
  const carried = carryStartedRules({ weekly: [], dated: [rule] }, stored, todayIso)
  return ruleProblem(carried.input.dated[0], { todayIso, knownKeys: carried.knownKeys })
}
// '2026-09-20' → '20 Sep', from the digits (no Date, so no timezone moves a day).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayMonth = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] || ''}`.trim()

const inputClass = 'rounded-md border border-un1t-border bg-un1t-bg px-2 py-1.5 text-sm text-un1t-text'
const labelClass = 'flex flex-col text-xs text-un1t-subtle gap-1'

function RuleRow({ row, todayIso, stored, showProblem, serverIssues, onChange, onRemove }) {
  const set = (patch) => onChange({ ...row, ...patch })
  // The client's own check first; else what the server said about this row
  // (placed by placeIssues against the order the server indexed).
  const problem = (showProblem ? rowProblem(row, todayIso, stored) : null)
    || (serverIssues?.length ? serverIssues.join('. ') : null)
  const started = Boolean(row.startedOn)
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-end gap-3">
        {row.kind === 'weekly' ? (
          <label className={labelClass}>
            Day
            <select aria-label="Day of the week" className={inputClass} value={row.weekday} onChange={(e) => set({ weekday: e.target.value })}>
              {AVAILABILITY_WEEKDAYS.map((d) => <option key={d} value={d}>{AVAILABILITY_WEEKDAY_LABELS[d]}</option>)}
            </select>
          </label>
        ) : (
          <>
            <label className={labelClass}>
              First day
              <input
                aria-label="First day" type="date" min={todayIso} className={inputClass} value={row.start_date} disabled={started}
                // Moving the first day past the last drags the last day with
                // it, so a one-day entry stays one day.
                onChange={(e) => set({ start_date: e.target.value, end_date: row.end_date && row.end_date >= e.target.value ? row.end_date : e.target.value })}
              />
            </label>
            <label className={labelClass}>
              Last day
              <input aria-label="Last day" type="date" min={started ? todayIso : (row.start_date || todayIso)} className={inputClass} value={row.end_date} onChange={(e) => set({ end_date: e.target.value })} />
            </label>
          </>
        )}
        <label className="flex items-center gap-1.5 text-sm text-un1t-text pb-1.5">
          <input aria-label="All day" type="checkbox" className="accent-un1t-text" checked={row.all_day} disabled={started} onChange={(e) => set({ all_day: e.target.checked })} />
          All day
        </label>
        {!row.all_day && (
          <>
            <label className={labelClass}>
              From
              <input aria-label="From" type="time" className={inputClass} value={row.start_time} disabled={started} onChange={(e) => set({ start_time: e.target.value })} />
            </label>
            <label className={labelClass}>
              To
              <input aria-label="To" type="time" className={inputClass} value={row.end_time} disabled={started} onChange={(e) => set({ end_time: e.target.value })} />
            </label>
          </>
        )}
        <label className={`${labelClass} grow min-w-[10rem]`}>
          Note (optional)
          <input aria-label="Note" type="text" maxLength={AVAILABILITY_LIMITS.noteChars} className={inputClass} value={row.note} onChange={(e) => set({ note: e.target.value })} />
        </label>
        <Button variant="ghost" size="sm" icon={Trash2} onClick={onRemove}>Remove</Button>
      </div>
      {started && (
        <p className="mt-1 text-xs text-un1t-subtle">
          Started {dayMonth(row.startedOn)}. The days already gone stay as they are: you can change the last day or the note, or remove it from today.
        </p>
      )}
      {problem && <p className="mt-1 text-xs text-red-700">{problem}</p>}
    </li>
  )
}

export default function AvailabilityEditor({ todayIso }) {
  const [rows, setRows] = useState(null)
  const [stored, setStored] = useState([])
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const [message, setMessage] = useState(null) // { tone: 'ok' | 'error', text }
  // { [rowKey]: [message] } from the last refused save; a row's entry goes
  // when that row is edited or removed.
  const [serverIssues, setServerIssues] = useState({})

  useEffect(() => {
    let live = true
    readJson('/api/schedule/availability')
      .then((body) => {
        if (!live) return
        setRows(rowsFrom(body.data, todayIso))
        setStored(startedFrom(body.data, todayIso))
      })
      .catch((e) => { if (live) setLoadError(e?.message || 'Could not load your availability') })
    return () => { live = false }
  }, [todayIso])

  const dropIssues = (key) => setServerIssues((prev) => {
    if (!(key in prev)) return prev
    const next = { ...prev }
    delete next[key]
    return next
  })
  const update = (key, next) => {
    setRows((prev) => prev.map((r) => (r.key === key ? next : r)))
    dropIssues(key)
  }
  const remove = (key) => {
    setRows((prev) => prev.filter((r) => r.key !== key))
    dropIssues(key)
  }
  const add = (kind) => setRows((prev) => [...prev, kind === 'weekly'
    ? { key: nextKey(), kind, weekday: 'mon', start_date: '', end_date: '', all_day: false, start_time: '', end_time: '', note: '' }
    : { key: nextKey(), kind, weekday: 'mon', start_date: todayIso, end_date: todayIso, all_day: true, start_time: '', end_time: '', note: '' }])

  async function save() {
    setShowProblems(true)
    if (rows.some((r) => rowProblem(r, todayIso, stored))) {
      setMessage({ tone: 'error', text: 'Fix the entries marked below, then save.' })
      return
    }
    setSaving(true)
    setMessage(null)
    setServerIssues({})
    // The server's own order, so the issue paths it answers index `sent`.
    const { body: payload, sent } = planSave(rows)
    try {
      const res = await fetch('/api/schedule/availability', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        const placed = placeIssues(body?.issues, sent)
        setServerIssues(placed.byRow)
        const general = placed.general.length ? placed.general.join('. ') : null
        const marked = Object.keys(placed.byRow).length ? 'Fix the entries marked below, then save.' : null
        setMessage({ tone: 'error', text: general || marked || body?.error || `Could not save (${res.status}).` })
        return
      }
      setRows(rowsFrom(body.data, todayIso))
      setStored(startedFrom(body.data, todayIso))
      setShowProblems(false)
      setMessage({ tone: 'ok', text: body.data?.changed ? 'Saved. Your managers will get a notification.' : 'Nothing changed.' })
    } catch {
      setMessage({ tone: 'error', text: 'Could not save. Check your connection and try again.' })
    } finally {
      setSaving(false)
    }
  }

  if (loadError) return <p className="text-sm text-red-700">{loadError}</p>
  if (!rows) return <p className="text-sm text-un1t-subtle">Loading your availability…</p>

  const section = (kind) => rows.filter((r) => r.kind === kind)
  const list = (kind) => (
    <ul className="divide-y divide-un1t-border">
      {section(kind).map((r) => (
        <RuleRow key={r.key} row={r} todayIso={todayIso} stored={stored} showProblem={showProblems} serverIssues={serverIssues[r.key]} onChange={(next) => update(r.key, next)} onRemove={() => remove(r.key)} />
      ))}
    </ul>
  )
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-un1t-text">My availability</h1>
        <p className="text-sm text-un1t-subtle mt-1">
          Tell your managers when you can&apos;t work. Every other time counts as available. There is nothing to approve:
          your managers at each of your studios get a notification when you save. Your managers can see your notes.
          A time window stays within one day: it can&apos;t run past midnight.
        </p>
      </div>

      {/* While a save is in flight nothing here takes input: a success
          replaces every row with the server's answer, so an edit typed now
          would silently vanish. A disabled fieldset disables every control
          inside it, the Add and Remove buttons included. min-w-0 undoes a
          fieldset's min-content width, which would push a phone sideways. */}
      <fieldset disabled={saving} className="min-w-0 m-0 p-0 border-0 space-y-6">
        <Card title="Every week" actions={<Button variant="secondary" size="sm" icon={Plus} onClick={() => add('weekly')}>Add a weekly time</Button>}>
          {section('weekly').length === 0
            ? <p className="text-sm text-un1t-subtle">No weekly times. Add one for a day you can never work, or part of one.</p>
            : list('weekly')}
        </Card>

        <Card title="Dates" actions={<Button variant="secondary" size="sm" icon={Plus} onClick={() => add('dated')}>Add a date</Button>}>
          {section('dated').length === 0
            ? <p className="text-sm text-un1t-subtle">No dates. Add one for a day or a run of days you can&apos;t work.</p>
            : list('dated')}
        </Card>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving}>Save</Button>
        {message && (
          <p role="status" className={`text-sm ${message.tone === 'ok' ? 'text-green-700' : 'text-red-700'}`}>{message.text}</p>
        )}
      </div>
    </div>
  )
}
