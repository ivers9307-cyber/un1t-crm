'use client'

// QUALS.1 — Schedule › Qualifications. One page for everyone at the studio:
//   manager (owner or manager here, or master): every current member, one row
//     per active qualification type (+ any record of an archived type), a
//     status chip, and add / edit / delete. Owners also get the catalogue.
//   self (everyone else): their own rows, read-only.
// The server decides the audience (GET /api/qualifications); every button
// here is re-judged by its route. Statuses come from shared/qualifications.js
// against the server's Dublin `today`, so the browser's clock never decides.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Pencil } from 'lucide-react'
import Modal from '@/components/ui/Modal'
import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'
import { readJson } from './schedule/useScheduleData'
import {
  qualificationStatus, qualificationStatusLabel, personNeedsAttention, QUALIFICATION_EXPIRY_WINDOW_DAYS,
} from '@shared/qualifications'

// Status chips: bg-<c>-500/10 text-<c>-700 (the light-theme recipe, check:guardrails).
const CHIP = {
  valid: 'bg-emerald-500/10 text-emerald-700',
  expiring: 'bg-amber-500/10 text-amber-700',
  expired: 'bg-red-500/10 text-red-700',
  missing: 'bg-slate-500/10 text-slate-700',
  unknown: 'bg-slate-500/10 text-slate-700',
}
const WORD = { valid: 'Valid', expiring: 'Expiring', expired: 'Expired', missing: 'Not on record', unknown: 'Check' }
const JSON_HEADERS = { 'Content-Type': 'application/json' }
const INPUT = 'mt-1 w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'

// One row per active type, then any record of an archived type.
function rowsFor(person, types) {
  const byType = new Map((person.records || []).map((r) => [r.qualification_type_id, r]))
  const rows = types.filter((t) => t.active !== false).map((type) => ({ type, record: byType.get(type.id) || null }))
  for (const t of types) {
    if (t.active === false && byType.has(t.id)) rows.push({ type: t, record: byType.get(t.id) })
  }
  return rows
}

export default function QualificationsManager({ locationId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [editing, setEditing] = useState(null) // { person, type, record | null }

  const load = useCallback(async () => {
    if (!locationId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const json = await readJson(`/api/qualifications?location_id=${encodeURIComponent(locationId)}`)
      setData(json?.data || null)
    } catch (e) {
      setError(e?.message || 'Could not load qualifications')
    } finally {
      setLoading(false)
    }
  }, [locationId])

  useEffect(() => { load() }, [load])

  const today = data?.today
  const types = useMemo(() => data?.types || [], [data])
  const isManager = data?.audience === 'manager'
  const people = useMemo(() => {
    const list = data?.people || []
    return attentionOnly ? list.filter((p) => personNeedsAttention(p.records, today)) : list
  }, [data, attentionOnly, today])

  const done = useCallback((message) => {
    setEditing(null)
    setNotice(message)
    load()
  }, [load])

  if (!locationId) return <p className="text-sm text-un1t-subtle">Choose a studio first.</p>
  if (loading && !data) return <p className="text-sm text-un1t-subtle">Loading qualifications…</p>
  if (!data) return <ScheduleErrorBanner title="Could not load qualifications" message={error} onRetry={load} />

  return (
    <div className="space-y-4">
      {error && <ScheduleErrorBanner title="Something went wrong" message={error} onDismiss={() => setError(null)} />}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}

      {isManager ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />
          Only people with something expired or expiring in the next {QUALIFICATION_EXPIRY_WINDOW_DAYS} days
        </label>
      ) : (
        <p className="text-sm text-un1t-subtle">Your manager records these. Tell them when you renew one.</p>
      )}

      {people.length === 0 && (
        <p className="text-sm text-un1t-subtle">{attentionOnly ? 'Nothing expired or expiring.' : 'Nobody here yet.'}</p>
      )}

      {people.map((p) => (
        <section key={p.profile_id} aria-label={p.full_name || 'Unnamed'} className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          {isManager && <h3 className="font-semibold mb-2">{p.full_name || 'Unnamed'}</h3>}
          <ul className="divide-y divide-un1t-border">
            {rowsFor(p, types).map(({ type, record }) => {
              const status = qualificationStatus(record, today) ?? 'unknown'
              return (
                <li key={type.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm">{type.name}{type.active === false ? ' (archived)' : ''}</div>
                    <div className="text-xs text-un1t-subtle">
                      {qualificationStatusLabel(record, today)}{record?.note ? ` · ${record.note}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${CHIP[status]}`}>{WORD[status]}</span>
                    {isManager && (
                      <button
                        type="button"
                        onClick={() => { setNotice(null); setEditing({ person: p, type, record }) }}
                        aria-label={`${record ? 'Edit' : 'Add'} ${type.name} for ${p.full_name || 'this person'}`}
                        className="p-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
                      >
                        {record ? <Pencil size={14} /> : <Plus size={14} />}
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {data.can_edit_types && (
        <TypesCatalogue types={types} locationId={locationId} onChanged={done} onError={setError} />
      )}
      {editing && <RecordModal {...editing} onClose={() => setEditing(null)} onDone={done} />}
    </div>
  )
}

function RecordModal({ person, type, record, onClose, onDone }) {
  const [issuedOn, setIssuedOn] = useState(record?.issued_on || '')
  const [expiresOn, setExpiresOn] = useState(record?.expires_on || '')
  const [noExpiry, setNoExpiry] = useState(!!record && !record.expires_on)
  const [note, setNote] = useState(record?.note || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const who = person.full_name || 'this person'
  const canSave = !busy && (noExpiry || !!expiresOn)

  async function save() {
    setBusy(true)
    setError(null)
    const body = { issued_on: issuedOn || null, expires_on: noExpiry ? null : expiresOn, note: note.trim() || null }
    try {
      if (record) {
        await readJson(`/api/qualifications/${record.id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) })
      } else {
        await readJson('/api/qualifications', {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ ...body, profile_id: person.profile_id, qualification_type_id: type.id }),
        })
      }
      onDone(`${type.name} saved for ${who}.`)
    } catch (e) {
      setError(e?.message || 'Could not save')
      setBusy(false)
    }
  }

  async function remove() {
    if (!record || !window.confirm(`Delete ${type.name} for ${who}? This cannot be undone.`)) return
    setBusy(true)
    setError(null)
    try {
      await readJson(`/api/qualifications/${record.id}`, { method: 'DELETE' })
      onDone(`${type.name} deleted for ${who}.`)
    } catch (e) {
      setError(e?.message || 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${type.name} · ${who}`}
      dismissOnBackdrop={false}
      footer={(
        <>
          {record && (
            <button type="button" onClick={remove} disabled={busy} className="mr-auto text-sm text-red-700 disabled:opacity-50">Delete</button>
          )}
          <button type="button" onClick={onClose} className="text-sm px-3 py-2">Cancel</button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="text-sm px-3 py-2 rounded-md bg-un1t-text text-un1t-bg disabled:opacity-50"
          >
            Save
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <label className="block text-xs text-un1t-subtle">
          Issued on (optional)
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={INPUT} />
        </label>
        <label className="block text-xs text-un1t-subtle">
          Expires on
          <input type="date" value={expiresOn} disabled={noExpiry} onChange={(e) => setExpiresOn(e.target.value)} className={INPUT} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} />
          Does not expire
        </label>
        <label className="block text-xs text-un1t-subtle">
          Note (optional)
          <textarea
            value={note}
            maxLength={300}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. the certificate number or who issued it"
            className={INPUT}
          />
        </label>
      </div>
    </Modal>
  )
}

function TypesCatalogue({ types, locationId, onChanged, onError }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(work, message) {
    setBusy(true)
    try {
      await work()
      onChanged(message)
    } catch (e) {
      onError(e?.message || 'Could not change the list')
    } finally {
      setBusy(false)
    }
  }

  const patch = (t, body, message) => run(() => readJson(`/api/qualifications/types/${t.id}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body),
  }), message)

  function add() {
    const clean = name.trim()
    if (!clean) return
    run(async () => {
      await readJson('/api/qualifications/types', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ location_id: locationId, name: clean }),
      })
      setName('')
    }, `${clean} added.`)
  }

  function rename(t) {
    const next = window.prompt('New name', t.name)?.trim()
    if (next && next !== t.name) patch(t, { name: next }, `Renamed to ${next}.`)
  }

  return (
    <section aria-label="Qualification types" className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="font-semibold mb-1">Qualification types</h3>
      <p className="text-xs text-un1t-subtle mb-3">
        Shared by every studio in your organisation. Archiving a type hides it from new records, the weekly summary and
        the coach picker, and keeps what is already recorded.
      </p>
      <ul className="divide-y divide-un1t-border mb-3">
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>{t.name}{t.active === false ? ' (archived)' : ''}</span>
            <span className="flex gap-3">
              <button type="button" disabled={busy} onClick={() => rename(t)} className="text-xs text-un1t-subtle hover:text-un1t-text">Rename</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => patch(t, { active: t.active === false }, t.active === false ? `${t.name} restored.` : `${t.name} archived.`)}
                className="text-xs text-un1t-subtle hover:text-un1t-text"
              >
                {t.active === false ? 'Restore' : 'Archive'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          aria-label="New qualification type"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Manual handling"
          className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        />
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={add}
          className="text-sm px-3 py-2 rounded-md bg-un1t-text text-un1t-bg disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </section>
  )
}
