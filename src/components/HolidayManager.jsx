'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, Flag, Building2 } from 'lucide-react'

export default function HolidayManager({ locationId, initialHolidays }) {
  const router = useRouter()
  const [holidays, setHolidays] = useState(initialHolidays || [])
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Group by year for cleaner display
  const byYear = holidays.reduce((acc, h) => {
    const year = h.date.slice(0, 4)
    if (!acc[year]) acc[year] = []
    acc[year].push(h)
    return acc
  }, {})

  async function handleAdd(e) {
    e.preventDefault()
    setError(null)
    if (!date || !name.trim()) {
      setError('Date and name are required')
      return
    }
    setSaving(true)
    const res = await fetch(`/api/locations/${locationId}/holidays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, name: name.trim() }),
    })
    const data = await res.json()
    setSaving(false)

    if (!data.success) {
      const issues = Array.isArray(data.issues) && data.issues.length
        ? data.issues.map(i => `${i.path || '(root)'}: ${i.message}`).join('; ')
        : null
      setError(issues ? `${data.error} — ${issues}` : (data.error || 'Failed to save'))
      return
    }

    // Insert/replace by date — same-date update overrides the existing entry
    setHolidays(prev => {
      const filtered = prev.filter(h => h.date !== data.data.date)
      return [...filtered, data.data].sort((a, b) => a.date.localeCompare(b.date))
    })
    setDate('')
    setName('')
    router.refresh()
  }

  async function handleDelete(holidayId) {
    if (!confirm('Remove this custom holiday?')) return
    const res = await fetch(`/api/locations/${locationId}/holidays/${holidayId}`, {
      method: 'DELETE',
    })
    const data = await res.json()
    if (data.success) {
      setHolidays(prev => prev.filter(h => h.id !== holidayId))
      router.refresh()
    }
  }

  return (
    <div className="space-y-6">
      {/* Add form */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Add Custom Holiday</h3>
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-2.5 mb-3">
            {error}
          </div>
        )}
        <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-3 items-end">
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            />
          </div>
          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={200}
              placeholder="e.g. Good Friday — closed"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 bg-un1t-text text-un1t-bg px-4 py-2 rounded-md hover:bg-un1t-accent text-sm font-medium disabled:opacity-50"
          >
            <Plus size={14} /> {saving ? 'Adding…' : 'Add Holiday'}
          </button>
        </form>
        <p className="text-xs text-un1t-subtle mt-2">
          Adding a holiday on the same date as an Irish public holiday will replace its name on the schedule (use this to mark statutory holidays as &ldquo;Closed&rdquo;).
        </p>
      </div>

      {/* List */}
      <div className="space-y-4">
        {Object.entries(byYear).sort(([a], [b]) => a.localeCompare(b)).map(([year, list]) => (
          <div key={year}>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">{year}</h4>
            <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[500px]">
                <tbody className="divide-y divide-un1t-border">
                  {list.map(h => (
                    <tr key={h.id || `static-${h.date}`} className="hover:bg-un1t-border/20">
                      <td className="p-3 w-32 font-mono text-un1t-subtle text-xs">{h.date}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {h.source === 'national' ? (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-700">
                              <Flag size={10} /> National
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700">
                              <Building2 size={10} /> Custom
                            </span>
                          )}
                          <span className="font-medium">{h.name}</span>
                        </div>
                      </td>
                      <td className="p-3 w-12 text-right">
                        {h.source === 'custom' && (
                          <button
                            onClick={() => handleDelete(h.id)}
                            className="text-un1t-muted hover:text-red-400"
                            title="Remove custom holiday"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
