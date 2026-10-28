'use client'

// FEES.1 — the class-fees review page body: tabs (Due, Outstanding,
// Undecided, History), waive with a reason, and the studio's fee settings.

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, EmptyState, Loading, Modal, Field } from '@/components/ui'
import { formatInZone } from '@/lib/location-time'

const TABS = [
  { key: 'due', label: 'Due to charge' },
  { key: 'outstanding', label: 'Outstanding' },
  { key: 'undecided', label: 'Undecided' },
  { key: 'history', label: 'History' },
  { key: 'exempt', label: 'Never charged' },
]

const KIND = { late_cancel: 'Late cancel', no_show: 'No-show' }
const STATUS = {
  preview: { label: 'Dry run, not charged', cls: 'bg-gray-500/10 text-gray-700' },
  appealed: { label: 'Appealed, on hold', cls: 'bg-violet-500/10 text-violet-700' },
  pending: { label: 'To charge', cls: 'bg-blue-500/10 text-blue-700' },
  charging: { label: 'Charging', cls: 'bg-amber-500/10 text-amber-700' },
  retry_scheduled: { label: 'Retry scheduled', cls: 'bg-amber-500/10 text-amber-700' },
  outstanding: { label: 'Outstanding', cls: 'bg-red-500/10 text-red-700' },
  charged: { label: 'Charged', cls: 'bg-green-500/10 text-green-700' },
  waived: { label: 'Waived', cls: 'bg-gray-500/10 text-gray-700' },
  recorded: { label: 'Credit kept', cls: 'bg-gray-500/10 text-gray-700' },
  undecided: { label: 'Not marked', cls: 'bg-amber-500/10 text-amber-700' },
}
const WAIVABLE = new Set(['preview', 'pending', 'retry_scheduled', 'outstanding', 'appealed'])
const APPEALABLE = new Set(['pending', 'retry_scheduled', 'outstanding'])
const APPEAL_REASON = { illness: 'Ill', injury: 'Injured', emergency: 'Emergency', other: 'Something else' }
const euro = (c) => `€${(Number(c || 0) / 100).toFixed(2)}`

export default function ClassFeesReview({ locationId, canEditSettings }) {
  const [tab, setTab] = useState('due')
  const [rows, setRows] = useState([])
  const [settings, setSettings] = useState(null)
  const [zone, setZone] = useState(null)
  const [notUn1t, setNotUn1t] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [waiving, setWaiving] = useState(null)
  const [exempt, setExempt] = useState([])

  async function setExemption(contactId, on) {
    const res = await fetch('/api/class-fees/exemptions', {
      method: on ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: locationId, contact_id: contactId }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
    await load()
    return json.data
  }
  const [rowMsg, setRowMsg] = useState({})

  async function rowAction(r, path, done, custom = null) {
    setRowMsg((m) => ({ ...m, [r.id]: 'Working…' }))
    if (custom) {
      try { const out = await custom(); setRowMsg((m) => ({ ...m, [r.id]: out })) } catch (e) { setRowMsg((m) => ({ ...m, [r.id]: e.message || 'Failed' })) }
      return
    }
    try {
      const res = await fetch(`/api/class-fees/${r.id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setRowMsg((m) => ({ ...m, [r.id]: done(json.data) }))
    } catch (e) {
      setRowMsg((m) => ({ ...m, [r.id]: e.message || 'Failed' }))
    }
  }
  const chargeAnyway = (r) => rowAction(r, 'charge-anyway', () => { load(); return 'Back to charging: taken at the next hourly run.' })
  const appealLink = (r) => rowAction(r, 'appeal-link', (d) => {
    try { navigator.clipboard?.writeText(d.url) } catch { /* the link is shown anyway */ }
    return `Appeal link copied: ${d.url}`
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'exempt') {
        const ex = await fetch(`/api/class-fees/exemptions?location_id=${encodeURIComponent(locationId)}`)
        const exJson = await ex.json()
        if (!ex.ok || !exJson.success) throw new Error(exJson.error || `HTTP ${ex.status}`)
        setExempt(exJson.data.rows || [])
      }
      const res = await fetch(`/api/class-fees?location_id=${encodeURIComponent(locationId)}&tab=${tab === 'exempt' ? 'due' : tab}`)
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setRows(json.data.rows || [])
      setSettings(json.data.settings)
      setZone(json.data.zone)
      setNotUn1t(!!json.data.notUn1t)
    } catch (e) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [locationId, tab])

  useEffect(() => { load() }, [load])

  const when = (iso) => (iso && zone ? formatInZone(iso, zone, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '')

  if (notUn1t) {
    return <EmptyState title="Not a un1t.online studio" description="Class fees work only at a studio whose bookings live in un1t.online." />
  }

  return (
    <div className="space-y-6">
      {settings && !settings.enabled && (
        <p className="text-sm rounded-lg bg-amber-500/10 text-amber-700 px-3 py-2">Class fees are switched off at this studio. Nothing is listed or charged until an owner switches them on below.</p>
      )}
      {settings?.enabled && settings.chargingPaused && (
        <p className="text-sm rounded-lg bg-amber-500/10 text-amber-700 px-3 py-2">Charging is paused (dry run): fees are listed and emailed to you as &quot;Dry run, not charged&quot;. They stay uncharged after you switch charging on; only fees found from then on are charged, and members are emailed only then.</p>
      )}

      <div className="flex rounded-lg border border-un1t-border overflow-hidden w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-sm ${tab === t.key ? 'bg-un1t-border/40 text-un1t-text' : 'bg-un1t-surface text-un1t-subtle hover:text-un1t-text'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'undecided' && (
        <p className="text-sm text-un1t-subtle">These bookings are still marked booked after the class. Mark them attended or no-show in un1t.online; they are never charged while unmarked.</p>
      )}

      {tab === 'exempt' && !loading && !error && (
        <ExemptList rows={exempt} onRemove={(cid) => setExemption(cid, false)} />
      )}

      {tab === 'exempt' ? null : loading ? <Loading /> : error ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing here" description={tab === 'due' ? 'No fees are waiting to be charged.' : 'No rows to show.'} />
      ) : (
        <Card padding="none">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-un1t-subtle border-b border-un1t-border">
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Class</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 font-medium text-right">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS[r.status] || { label: r.status, cls: 'bg-gray-500/10 text-gray-700' }
                return (
                  <tr key={r.id} className="border-b border-un1t-border last:border-0 align-top">
                    <td className="px-3 py-2">
                      {r.contact_id ? <a className="text-un1t-accent hover:underline" href={`/contacts/${r.contact_id}`}>{r.member_name || 'Member'}</a> : (r.member_name || 'Not linked to a contact')}
                    </td>
                    <td className="px-3 py-2">{r.class_title || 'Class'}<div className="text-xs text-un1t-subtle">{when(r.starts_at)}</div></td>
                    <td className="px-3 py-2">
                      {KIND[r.kind] || '—'}
                      {r.kind === 'late_cancel' && Number.isFinite(r.minutes_before_start) && (
                        <div className="text-xs text-un1t-subtle">{r.minutes_before_start} min before</div>
                      )}
                      {r.failure_message && <div className="text-xs text-red-700">{r.failure_message}</div>}
                      {r.status === 'waived' && r.waived_reason && <div className="text-xs text-un1t-subtle">Waived: {r.waived_reason}</div>}
                      {r.appealed_at && (
                        <div className="text-xs text-violet-700">
                          Appeal: {APPEAL_REASON[r.appeal_reason] || r.appeal_reason}{r.appeal_text ? `, "${r.appeal_text}"` : ''}
                        </div>
                      )}
                      {r.notice_sent_at && <div className="text-xs text-un1t-subtle">Member emailed</div>}
                      {rowMsg[r.id] && <div className="text-xs text-un1t-subtle break-all">{rowMsg[r.id]}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">{r.penalty === 'credit_forfeit' ? 'Credit' : r.amount_cents ? euro(r.amount_cents) : ''}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                      {r.status === 'pending' && r.charge_due_at && <div className="text-xs text-un1t-subtle mt-1">{when(r.charge_due_at)}</div>}
                      {r.status === 'retry_scheduled' && r.next_attempt_at && <div className="text-xs text-un1t-subtle mt-1">Retry {when(r.next_attempt_at)}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-col items-end gap-1">
                        {WAIVABLE.has(r.status) && (
                          <Button type="button" variant="secondary" size="sm" onClick={() => setWaiving(r)}>Waive</Button>
                        )}
                        {r.status === 'appealed' && (
                          <Button type="button" variant="ghost" size="sm" onClick={() => chargeAnyway(r)}>Charge anyway</Button>
                        )}
                        {r.contact_id && r.penalty === 'fee' && WAIVABLE.has(r.status) && (
                          <Button type="button" variant="ghost" size="sm" onClick={() => rowAction(r, null, null, () => setExemption(r.contact_id, true).then((d) => `Never charged from now on${d?.waived ? ` (${d.waived} fee(s) waived)` : ''}.`))}>Never charge</Button>
                        )}
                        {settings?.appealsEnabled && APPEALABLE.has(r.status) && r.penalty === 'fee' && (
                          <Button type="button" variant="ghost" size="sm" onClick={() => appealLink(r)}>Appeal link</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      {waiving && (
        <WaiveModal
          fee={waiving}
          locationId={locationId}
          onClose={() => setWaiving(null)}
          onDone={() => { setWaiving(null); load() }}
        />
      )}

      {settings && <SettingsCard locationId={locationId} settings={settings} canEdit={canEditSettings} onSaved={load} />}
    </div>
  )
}

export function WaiveModal({ fee, locationId, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/class-fees/${fee.id}/waive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, reason }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      onDone()
    } catch (e2) {
      setErr(e2.message || 'Could not waive')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="Waive this fee">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-un1t-subtle">{fee.charge_description}</p>
        <Field id="waive-reason" label="Reason" required>
          {(p) => <textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border border-un1t-border bg-un1t-surface px-3 py-2 text-sm" />}
        </Field>
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !reason.trim()}>{busy ? 'Waiving…' : 'Waive fee'}</Button>
        </div>
      </form>
    </Modal>
  )
}

function SettingsCard({ locationId, settings, canEdit, onSaved }) {
  const [form, setForm] = useState(() => ({
    enabled: settings.enabled,
    charging_paused: settings.chargingPaused,
    late: (settings.lateCancelFeeCents / 100).toFixed(2),
    noShow: (settings.noShowFeeCents / 100).toFixed(2),
    emails: settings.reviewEmails.join(', '),
    fg: {
      swap: settings.forgiveness.swap.on,
      swap_minutes: settings.forgiveness.swap.minutes,
      spot_refilled: settings.forgiveness.spotRefilled.on,
      new_member: settings.forgiveness.newMember.on,
      new_member_days: settings.forgiveness.newMember.days,
      first_offence: settings.forgiveness.firstOffence.on,
      first_offence_days: settings.forgiveness.firstOffence.days,
      monthly_cap: settings.forgiveness.monthlyCap.on,
      monthly_cap_count: settings.forgiveness.monthlyCap.cap,
    },
    notice_enabled: settings.noticeEnabled,
    appeals_enabled: settings.appealsEnabled,
    notice_subject: settings.noticeSubject,
    notice_body: settings.noticeBody,
    appeal_line: settings.appealLine,
  }))
  const setFg = (k, v) => setForm((f) => ({ ...f, fg: { ...f.fg, [k]: v } }))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const toCents = (v) => Math.round(Number(String(v).replace(',', '.')) * 100)

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const late = toCents(form.late)
      const noShow = toCents(form.noShow)
      if (!Number.isFinite(late) || !Number.isFinite(noShow) || late < 0 || noShow < 0) throw new Error('Enter the fees as euro amounts, e.g. 10.00')
      const res = await fetch('/api/class-fees/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          enabled: form.enabled,
          charging_paused: form.charging_paused,
          late_cancel_fee_cents: late,
          no_show_fee_cents: noShow,
          review_emails: form.emails.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
          forgiveness: {
            ...form.fg,
            swap_minutes: Number(form.fg.swap_minutes),
            new_member_days: Number(form.fg.new_member_days),
            first_offence_days: Number(form.fg.first_offence_days),
            monthly_cap_count: Number(form.fg.monthly_cap_count),
          },
          notice_enabled: form.notice_enabled,
          appeals_enabled: form.appeals_enabled,
          notice_subject: form.notice_subject,
          notice_body: form.notice_body,
          appeal_line: form.appeal_line,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setMsg('Saved')
      onSaved()
    } catch (e2) {
      setMsg(e2.message || 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full rounded-lg border border-un1t-border bg-un1t-surface px-3 py-2 text-sm disabled:opacity-60'
  return (
    <Card title="Settings">
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!canEdit} checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Class fees on at this studio
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!canEdit} checked={form.charging_paused} onChange={(e) => setForm({ ...form, charging_paused: e.target.checked })} />
          Pause charging (list and email only)
        </label>
        <Field id="fee-late" label="Late cancellation fee (€)">
          {(p) => <input {...p} disabled={!canEdit} inputMode="decimal" value={form.late} onChange={(e) => setForm({ ...form, late: e.target.value })} className={input} />}
        </Field>
        <Field id="fee-noshow" label="No-show fee (€)">
          {(p) => <input {...p} disabled={!canEdit} inputMode="decimal" value={form.noShow} onChange={(e) => setForm({ ...form, noShow: e.target.value })} className={input} />}
        </Field>
        <Field id="fee-emails" label="Review email recipients" hint="Comma-separated. They get the list at 23:00." className="sm:col-span-2">
          {(p) => <input {...p} disabled={!canEdit} value={form.emails} onChange={(e) => setForm({ ...form, emails: e.target.value })} className={input} />}
        </Field>
        <fieldset className="sm:col-span-2 space-y-2">
          <legend className="text-sm font-medium text-un1t-text mb-1">Forgive automatically</legend>
          <ForgiveRow disabled={!canEdit} checked={form.fg.swap} onCheck={(v) => setFg('swap', v)}
            label="Moved to another class" num={form.fg.swap_minutes} onNum={(v) => setFg('swap_minutes', v)} unit="minutes to rebook" />
          <ForgiveRow disabled={!canEdit} checked={form.fg.new_member} onCheck={(v) => setFg('new_member', v)}
            label="New members and trials" num={form.fg.new_member_days} onNum={(v) => setFg('new_member_days', v)} unit="days from joining" />
          <ForgiveRow disabled={!canEdit} checked={form.fg.first_offence} onCheck={(v) => setFg('first_offence', v)}
            label="First offence is a warning" num={form.fg.first_offence_days} onNum={(v) => setFg('first_offence_days', v)} unit="day window" />
          <ForgiveRow disabled={!canEdit} checked={form.fg.spot_refilled} onCheck={(v) => setFg('spot_refilled', v)}
            label="Spot taken by someone else (late cancels)" />
          <ForgiveRow disabled={!canEdit} checked={form.fg.monthly_cap} onCheck={(v) => setFg('monthly_cap', v)}
            label="Monthly limit per member" num={form.fg.monthly_cap_count} onNum={(v) => setFg('monthly_cap_count', v)} unit="fees a month at most" />
          <p className="text-xs text-un1t-subtle">A forgiven fee shows on History as waived, with the rule that forgave it.</p>
        </fieldset>
        <fieldset className="sm:col-span-2 space-y-3">
          <legend className="text-sm font-medium text-un1t-text mb-1">Members</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!canEdit} checked={form.notice_enabled} onChange={(e) => setForm({ ...form, notice_enabled: e.target.checked })} />
            Email each member about their fee at {String(settings.detectHour).padStart(2, '0')}:00 (only while charging is on)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!canEdit} checked={form.appeals_enabled} onChange={(e) => setForm({ ...form, appeals_enabled: e.target.checked })} />
            Let members appeal a fee (an appeal holds it until you decide)
          </label>
          <p className="text-xs text-un1t-subtle">The two work on their own: with the email off you can still copy an appeal link from a fee and send it yourself.</p>
          <Field id="notice-subject" label="Email subject">
            {(p) => <input {...p} disabled={!canEdit} value={form.notice_subject} onChange={(e) => setForm({ ...form, notice_subject: e.target.value })} className={input} />}
          </Field>
          <Field id="notice-body" label="Email text" hint="Placeholders: {first_name} {what} {what_lower} {class} {class_time} {amount} {charge_time} {studio}. A blank line starts a new paragraph.">
            {(p) => <textarea {...p} rows={6} disabled={!canEdit} value={form.notice_body} onChange={(e) => setForm({ ...form, notice_body: e.target.value })} className={input} />}
          </Field>
          <Field id="appeal-line" label="Appeal line (added when appeals are on)" hint="Must include {appeal_link}.">
            {(p) => <textarea {...p} rows={2} disabled={!canEdit} value={form.appeal_line} onChange={(e) => setForm({ ...form, appeal_line: e.target.value })} className={input} />}
          </Field>
        </fieldset>
        <p className="text-xs text-un1t-subtle sm:col-span-2">
          A cancellation is late inside un1t.online&apos;s own cancellation window. The list is made at {String(settings.detectHour).padStart(2, '0')}:00 and fees are charged at {String(settings.chargeHour).padStart(2, '0')}:00 the next day; a refused charge is tried once more 7 days later. Pack members who lose a credit are recorded, never charged.
        </p>
        {canEdit ? (
          <div className="sm:col-span-2 flex items-center gap-3">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
            {msg && <span className="text-sm text-un1t-subtle">{msg}</span>}
          </div>
        ) : (
          <p className="text-xs text-un1t-subtle sm:col-span-2">Only an owner or master can change these.</p>
        )}
      </form>
    </Card>
  )
}

function ForgiveRow({ disabled, checked, onCheck, label, num, onNum, unit }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" disabled={disabled} checked={checked} onChange={(e) => onCheck(e.target.checked)} />
        {label}
      </label>
      {onNum && (
        <span className="flex items-center gap-1 text-un1t-subtle">
          <input
            type="number"
            min={1}
            disabled={disabled || !checked}
            value={num}
            onChange={(e) => onNum(e.target.value)}
            className="w-16 rounded-lg border border-un1t-border bg-un1t-surface px-2 py-1 text-sm disabled:opacity-60"
            aria-label={`${label}: ${unit}`}
          />
          {unit}
        </span>
      )}
    </div>
  )
}

function ExemptList({ rows, onRemove }) {
  const [msg, setMsg] = useState(null)
  return (
    <Card padding="none">
      <p className="text-sm text-un1t-subtle px-3 py-2 border-b border-un1t-border">
        These members are never charged a class fee here. Their late cancels and no-shows still show on History as waived. Add someone with &quot;Never charge&quot; on a fee or on their contact page.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-un1t-subtle px-3 py-4">Nobody yet.</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-un1t-border last:border-0 text-sm">
              <div>
                <a className="text-un1t-accent hover:underline" href={`/contacts/${r.contact_id}`}>{r.member_name || r.member_email || 'Member'}</a>
                {r.note && <div className="text-xs text-un1t-subtle">{r.note}</div>}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => onRemove(r.contact_id).catch((e) => setMsg(e.message))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="text-xs text-red-700 px-3 py-2">{msg}</p>}
    </Card>
  )
}
