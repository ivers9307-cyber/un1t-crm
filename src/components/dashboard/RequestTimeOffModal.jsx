'use client'

// RequestTimeOffModal — lightweight time-off request form for the Today dashboard.
// Mirrors the field set + validation from TimeOffManager.jsx without importing
// the whole manager. Uses POST /api/schedule/time-off.
// On success: calls onSuccess() so the parent can router.refresh() + show a
// confirmation.

import { useState } from 'react'
import Modal from '@/components/ui/Modal'
import Button from '@/components/ui/Button'
import { timeOffTypesFor, defaultTimeOffTypeFor } from '@shared/time-off'

function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function RequestTimeOffModal({ open, onClose, onSuccess, employmentType }) {
  const today = todayIso()
  const typeOptions = timeOffTypesFor(employmentType)
  const defaultType = defaultTimeOffTypeFor(employmentType)
  const [type, setType]           = useState(defaultType)
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate]     = useState(today)
  const [reason, setReason]       = useState('')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)

  function reset() {
    setType(defaultType)
    setStartDate(today)
    setEndDate(today)
    setReason('')
    setError(null)
    setSaving(false)
  }

  function handleClose() {
    reset()
    onClose?.()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!startDate || !endDate) {
      setError('Please select start and end dates.')
      return
    }
    if (endDate < startDate) {
      setError('End date cannot be before start date.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const res = await fetch('/api/schedule/time-off', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          start_date: startDate,
          end_date:   endDate,
          reason:     reason.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error || 'Could not submit request. Please try again.')
        setSaving(false)
        return
      }
      reset()
      onSuccess?.()
    } catch {
      setError('Network error. Please try again.')
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Request time off"
      size="sm"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="time-off-form" variant="primary" loading={saving}>
            Submit request
          </Button>
        </>
      }
    >
      <form id="time-off-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Type — dropdown when the employee has a choice; a static line
            when only one type is allowed (contractor / casual → Unavailable). */}
        <div>
          <label className="block text-xs font-medium text-un1t-subtle mb-1" htmlFor="tof-type">
            Type
          </label>
          {typeOptions.length > 1 ? (
            <select
              id="tof-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              disabled={saving}
              className="w-full rounded-lg border border-un1t-border bg-un1t-surface text-un1t-text text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-un1t-accent"
            >
              {typeOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-un1t-subtle">
              Type: <span className="font-medium text-un1t-text">{typeOptions[0]?.label}</span>
            </p>
          )}
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-un1t-subtle mb-1" htmlFor="tof-start">
              From
            </label>
            <input
              id="tof-start"
              type="date"
              value={startDate}
              min={today}
              onChange={(e) => {
                setStartDate(e.target.value)
                if (endDate < e.target.value) setEndDate(e.target.value)
              }}
              disabled={saving}
              required
              className="w-full rounded-lg border border-un1t-border bg-un1t-surface text-un1t-text text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-un1t-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-un1t-subtle mb-1" htmlFor="tof-end">
              To
            </label>
            <input
              id="tof-end"
              type="date"
              value={endDate}
              min={startDate || today}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={saving}
              required
              className="w-full rounded-lg border border-un1t-border bg-un1t-surface text-un1t-text text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-un1t-accent"
            />
          </div>
        </div>

        {/* Reason (optional) */}
        <div>
          <label className="block text-xs font-medium text-un1t-subtle mb-1" htmlFor="tof-reason">
            Reason <span className="text-un1t-muted font-normal">(optional)</span>
          </label>
          <textarea
            id="tof-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={saving}
            rows={2}
            maxLength={500}
            placeholder="Any context for your manager…"
            className="w-full rounded-lg border border-un1t-border bg-un1t-surface text-un1t-text text-sm px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-un1t-accent placeholder:text-un1t-muted"
          />
        </div>

        {/* Inline error */}
        {error && (
          <p className="text-sm text-red-700 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
        )}
      </form>
    </Modal>
  )
}
