'use client'

// LEAVEBAL.1 — Schedule › Leave balances. One row per active member of staff
// at the active studio (GET /api/schedule/allowances/team): holiday allowance
// in DAYS (total, carried over, used, pending, remaining) and time in lieu in
// HOURS. The two are never added together.
//
// From a row a manager:
//   • edits the year's total days and carry-over (PUT /api/schedule/allowances);
//   • opens the person's lieu ledger (GET /api/schedule/allowances/lieu), adds
//     hours or records lieu taken (POST, note required; a 409 says how much is
//     banked) and removes a manual or taken entry (DELETE). Automatic Sunday /
//     public-holiday credits are the roster's record and show no remove. Only
//     owners and managers record lieu (`can_record_lieu`); a head coach reads.
//
// A figure the server could not read arrives as null and shows as "Unknown",
// never 0. Contractors have no allowance and earn no lieu: "n/a".

import { useCallback, useEffect, useState } from 'react'
import { Button, Modal, Field, Table } from '@/components/ui'

const INPUT = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

export const PART_LABELS = Object.freeze({
  allowances: 'holiday allowances',
  entitlements: 'contract entitlements',
  pending: 'pending holiday requests',
  lieu: 'lieu ledgers',
})

export const LIEU_SOURCE_LABELS = Object.freeze({
  sunday_worked: 'Sunday worked',
  public_holiday_worked: 'Public holiday worked',
  manual: 'Hours added',
  taken: 'Lieu taken',
})

/** Pure: a number for a cell; null/undefined → "Unknown". */
export function fmtNumber(n, unit = '') {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return 'Unknown'
  const v = Math.round(Number(n) * 100) / 100
  return `${v}${unit}`
}

/** Pure: the years the picker offers around the studio's current year. */
export function yearOptions(current) {
  if (current === null || current === undefined || current === '') return []
  const y = Number(current)
  if (!Number.isInteger(y)) return []
  return [y - 2, y - 1, y, y + 1]
}

async function readJson(res) {
  try { return await res.json() } catch { return {} }
}

const Unknown = () => <span className="text-amber-700" title="Could not be read">Unknown</span>
const NotApplicable = () => <span className="text-un1t-subtle" title="Contractors have no holiday allowance and earn no lieu time">n/a</span>

function dayCell(row, key) {
  if (row.not_applicable) return <NotApplicable />
  if (!row.holiday) return <Unknown />
  return fmtNumber(row.holiday[key])
}

export default function LeaveBalancesManager() {
  const [year, setYear] = useState(null)
  const [currentYear, setCurrentYear] = useState(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null)
  const [ledgerFor, setLedgerFor] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async (y) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/schedule/allowances/team${y ? `?year=${y}` : ''}`)
      const json = await readJson(res)
      if (!res.ok || !json.success) throw new Error(json.error || 'Could not load leave balances')
      setData(json.data)
      setYear(json.data.year)
      setCurrentYear((c) => c ?? json.data.year)
    } catch (e) {
      setError(e?.message || 'Could not load leave balances')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(null) }, [load])

  const rows = data?.rows || []
  const unreadable = data?.unreadable || []
  const canRecordLieu = Boolean(data?.can_record_lieu)

  const columns = [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium">{r.full_name}</span> },
    { key: 'total', header: 'Holiday (days)', align: 'right', render: (r) => dayCell(r, 'total_days') },
    { key: 'carried', header: 'Carried over', align: 'right', render: (r) => dayCell(r, 'carried_over') },
    { key: 'used', header: 'Used', align: 'right', render: (r) => dayCell(r, 'used_days') },
    {
      key: 'pending', header: 'Pending', align: 'right',
      render: (r) => (r.not_applicable ? <NotApplicable /> : r.pending_days == null ? <Unknown /> : fmtNumber(r.pending_days)),
    },
    { key: 'remaining', header: 'Remaining', align: 'right', render: (r) => dayCell(r, 'remaining') },
    {
      key: 'lieu', header: 'Lieu (hours)', align: 'right',
      render: (r) => (r.not_applicable ? <NotApplicable /> : r.lieu == null ? <Unknown /> : fmtNumber(r.lieu.balance_hours, ' h')),
    },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right',
      render: (r) => (r.not_applicable ? null : (
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary" size="sm"
            aria-label={`Edit allowance for ${r.full_name}`}
            disabled={!r.holiday}
            onClick={() => { setNotice(null); setEditing(r) }}
          >
            Edit allowance
          </Button>
          <Button
            variant="secondary" size="sm"
            aria-label={`Lieu ledger for ${r.full_name}`}
            onClick={() => { setNotice(null); setLedgerFor(r) }}
          >
            Lieu ledger
          </Button>
        </div>
      )),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="leave-balances-year" label="Year">
          {(p) => (
            <select
              {...p}
              className={`${INPUT} w-32`}
              value={year ?? ''}
              disabled={!currentYear}
              onChange={(e) => load(Number(e.target.value))}
            >
              {yearOptions(currentYear).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
        </Field>
      </div>

      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {unreadable.length > 0 && (
        <p role="alert" className="text-sm rounded-md px-3 py-2 bg-amber-500/10 text-amber-700">
          Could not read {unreadable.map((p) => PART_LABELS[p] || p).join(', ')}. Those figures show as Unknown, not 0. Try again in a minute.
        </p>
      )}

      <div className="overflow-x-auto bg-un1t-surface border border-un1t-border rounded-lg">
        <Table
          columns={columns}
          rows={rows}
          loading={loading && !data}
          rowKey={(r) => r.profile_id}
          empty="No active staff at this studio."
        />
      </div>

      {editing && (
        <AllowanceEditor
          row={editing}
          year={year}
          onClose={() => setEditing(null)}
          onSaved={() => { setNotice(`Allowance saved for ${editing.full_name}.`); setEditing(null); load(year) }}
        />
      )}
      {ledgerFor && (
        <LieuLedger
          row={ledgerFor}
          year={year}
          locationId={data?.location_id}
          today={data?.today}
          canRecord={canRecordLieu}
          onClose={() => setLedgerFor(null)}
          onChanged={() => load(year)}
        />
      )}
    </div>
  )
}

function AllowanceEditor({ row, year, onClose, onSaved }) {
  const [total, setTotal] = useState(String(row.holiday?.total_days ?? ''))
  const [carried, setCarried] = useState(String(row.holiday?.carried_over ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const totalN = Number(total)
  const carriedN = Number(carried)
  const valid = total !== '' && carried !== '' && Number.isFinite(totalN) && Number.isFinite(carriedN)
    && totalN >= 0 && totalN <= 366 && carriedN >= 0 && carriedN <= 366

  async function save() {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/schedule/allowances', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: row.profile_id, year, total_days: totalN, carried_over: carriedN }),
      })
      const json = await readJson(res)
      if (!res.ok || !json.success) throw new Error(json.error || 'Could not save the allowance')
      onSaved()
    } catch (e) {
      setError(e?.message || 'Could not save the allowance')
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${row.full_name} · ${year} holiday allowance`}
      dismissOnBackdrop={false}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!valid} loading={busy}>Save</Button>
        </>
      )}
    >
      <div className="space-y-3">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <Field id="allowance-total" label="Total days" hint="The year's allowance in days (0 to 366).">
          {(p) => <input {...p} type="number" min="0" max="366" step="0.5" className={INPUT} value={total} onChange={(e) => setTotal(e.target.value)} />}
        </Field>
        <Field id="allowance-carried" label="Carried over (days)" hint="Days brought forward from last year.">
          {(p) => <input {...p} type="number" min="0" max="366" step="0.5" className={INPUT} value={carried} onChange={(e) => setCarried(e.target.value)} />}
        </Field>
        <p className="text-xs text-un1t-subtle">
          Used days come from approved holiday requests and are not edited here.
        </p>
      </div>
    </Modal>
  )
}

function LieuLedger({ row, year, locationId, today, canRecord, onClose, onChanged }) {
  const [ledger, setLedger] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [mode, setMode] = useState(null) // 'manual' | 'taken' | null
  const [hours, setHours] = useState('')
  const [date, setDate] = useState(today || '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState(null)
  const [confirmId, setConfirmId] = useState(null)
  const [removeError, setRemoveError] = useState(null)

  const loadLedger = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch(`/api/schedule/allowances/lieu?profile_id=${encodeURIComponent(row.profile_id)}&year=${year}`)
      const json = await readJson(res)
      if (!res.ok || !json.success) throw new Error(json.error || 'Could not read the lieu ledger')
      setLedger(json.data)
    } catch (e) {
      setLoadError(e?.message || 'Could not read the lieu ledger')
    }
  }, [row.profile_id, year])

  useEffect(() => { loadLedger() }, [loadLedger])

  const hoursN = Number(hours)
  const canSave = Boolean(mode) && hours !== '' && Number.isFinite(hoursN) && hoursN > 0 && hoursN <= 500
    && /^\d{4}-\d{2}-\d{2}$/.test(date) && note.trim().length > 0

  function openForm(m) {
    setMode(m)
    setHours('')
    setNote('')
    setDate(today || '')
    setFormError(null)
  }

  async function submit() {
    if (!canSave) return
    setBusy(true)
    setFormError(null)
    try {
      const res = await fetch('/api/schedule/allowances/lieu', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: row.profile_id, location_id: locationId, source: mode, hours: hoursN, credit_date: date, note: note.trim() }),
      })
      const json = await readJson(res)
      if (!res.ok || !json.success) throw new Error(json.error || 'Could not record the entry')
      setMode(null)
      await loadLedger()
      onChanged()
    } catch (e) {
      setFormError(e?.message || 'Could not record the entry')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    setBusy(true)
    setRemoveError(null)
    try {
      const res = await fetch(`/api/schedule/allowances/lieu?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const json = await readJson(res)
      if (!res.ok || !json.success) throw new Error(json.error || 'Could not remove the entry')
      setConfirmId(null)
      await loadLedger()
      onChanged()
    } catch (e) {
      setRemoveError(e?.message || 'Could not remove the entry')
    } finally {
      setBusy(false)
    }
  }

  const entries = ledger?.entries || []

  return (
    <Modal open onClose={onClose} title={`${row.full_name} · lieu ${year}`} size="lg" footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        {loadError && <p role="alert" className="text-sm text-red-700">{loadError}</p>}
        {ledger && (
          <p className="text-sm" aria-label="Lieu balance">
            Credited {fmtNumber(ledger.credited_hours, ' h')} · Taken {fmtNumber(ledger.taken_hours, ' h')} ·{' '}
            <span className="font-semibold">Balance {fmtNumber(ledger.balance_hours, ' h')}</span>
          </p>
        )}
        {!ledger && !loadError && <p className="text-sm text-un1t-subtle">Loading…</p>}

        {ledger && (
          entries.length === 0
            ? <p className="text-sm text-un1t-subtle">No lieu entries in {year}.</p>
            : (
              <ul className="divide-y divide-un1t-border" aria-label="Lieu entries">
                {entries.map((e) => {
                  const manual = e.source === 'manual' || e.source === 'taken'
                  return (
                    <li key={e.id} className="py-2 flex items-start gap-3 text-sm">
                      <span className="w-24 shrink-0 text-un1t-subtle">{e.credit_date}</span>
                      <span className="flex-1">
                        {LIEU_SOURCE_LABELS[e.source] || e.source}
                        {e.holiday_name ? ` · ${e.holiday_name}` : ''}
                        {e.note ? <span className="block text-xs text-un1t-subtle">{e.note}</span> : null}
                      </span>
                      <span className={`w-20 text-right font-medium ${e.hours < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                        {e.hours > 0 ? '+' : ''}{fmtNumber(e.hours, ' h')}
                      </span>
                      {canRecord && manual && (
                        confirmId === e.id ? (
                          <span className="flex gap-1">
                            <Button variant="danger" size="sm" loading={busy} onClick={() => remove(e.id)}>Confirm remove</Button>
                            <Button variant="ghost" size="sm" onClick={() => { setConfirmId(null); setRemoveError(null) }}>Keep</Button>
                          </span>
                        ) : (
                          <Button variant="ghost" size="sm" aria-label={`Remove ${LIEU_SOURCE_LABELS[e.source]} on ${e.credit_date}`} onClick={() => { setConfirmId(e.id); setRemoveError(null) }}>
                            Remove
                          </Button>
                        )
                      )}
                    </li>
                  )
                })}
              </ul>
            )
        )}
        {removeError && <p role="alert" className="text-sm text-red-700">{removeError}</p>}

        {canRecord && !mode && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => openForm('manual')}>Add hours</Button>
            <Button variant="secondary" onClick={() => openForm('taken')}>Record lieu taken</Button>
          </div>
        )}
        {!canRecord && (
          <p className="text-xs text-un1t-subtle">Only owners and managers at this studio can record lieu time.</p>
        )}

        {canRecord && mode && (
          <form
            className="space-y-3 border border-un1t-border rounded-md p-3"
            aria-label={mode === 'taken' ? 'Record lieu taken' : 'Add hours'}
            onSubmit={(ev) => { ev.preventDefault(); submit() }}
          >
            <p className="text-sm font-medium">{mode === 'taken' ? 'Record lieu taken' : 'Add hours'}</p>
            {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <Field id="lieu-hours" label="Hours" required>
                {(p) => <input {...p} type="number" min="0.25" max="500" step="0.25" className={INPUT} value={hours} onChange={(e) => setHours(e.target.value)} />}
              </Field>
              <Field id="lieu-date" label="Date" required>
                {(p) => <input {...p} type="date" className={INPUT} value={date} onChange={(e) => setDate(e.target.value)} />}
              </Field>
            </div>
            <Field id="lieu-note" label="Note" required hint="Why, for the record (required).">
              {(p) => <input {...p} type="text" maxLength={500} className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
              <Button type="submit" disabled={!canSave} loading={busy}>Save</Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}
