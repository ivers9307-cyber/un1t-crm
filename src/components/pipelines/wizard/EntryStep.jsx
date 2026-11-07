'use client'

import { useEffect, useState } from 'react'
import { Field, Loading } from '@/components/ui'
import { TRIAL_MATCHES } from '@shared/pipelines/offer-config.js'
import { entryDescription, TRIAL_MATCH_LABELS, ENTRY_TYPE_LABELS, ENTRY_TYPE_HELP } from '@/lib/pipeline-wizard'

// Step 3: who enters. The entry type comes from the recipe; the values are
// the studio's own (GET /api/locations/[id]/pipeline-entry-options).
// `disabled` makes it read-only (the settings page, while the board is on).
export default function EntryStep({ state, dispatch, locationId, entryTypes, disabled = false }) {
  const entry = state.entry
  const type = entry?.type
  const match = entry?.match
  const [opts, setOpts] = useState({ loading: true, error: null, options: [] })

  useEffect(() => {
    if (!type || !locationId) return undefined
    let cancelled = false
    setOpts({ loading: true, error: null, options: [] })
    const q = new URLSearchParams({ type })
    if (match) q.set('match', match)
    ;(async () => {
      try {
        const res = await fetch(`/api/locations/${locationId}/pipeline-entry-options?${q.toString()}`)
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || 'Could not load the options.')
        if (!cancelled) setOpts({ loading: false, error: null, options: json.data?.options || [] })
      } catch (e) {
        if (!cancelled) setOpts({ loading: false, error: e.message || 'Could not load the options.', options: [] })
      }
    })()
    return () => { cancelled = true }
  }, [type, match, locationId])

  if (!entry) return null
  const picked = new Set(entry.values)
  const toggle = (value) => {
    const next = picked.has(value) ? entry.values.filter((v) => v !== value) : [...entry.values, value]
    dispatch({ type: 'setEntryValues', values: next })
  }
  // A value already picked that the studio no longer lists stays visible, so it can be unticked.
  const listed = new Set(opts.options.map((o) => o.value))
  const options = [...opts.options, ...entry.values.filter((v) => !listed.has(v)).map((v) => ({ value: v, label: v }))]

  const types = entryTypes || state.studio?.entryTypes
  return (
    <div className="space-y-4">
      {types && types.length > 0 && (
        <Field id="wiz-entry-type" label="Who enters" hint={ENTRY_TYPE_HELP[type]}>
          {(p) => (
            <select {...p} disabled={disabled} value={type || ''} onChange={(e) => dispatch({ type: 'setEntryType', entryType: e.target.value })}
              className="rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text">
              {[...new Set([...(type && !types.includes(type) ? [type] : []), ...types])].map((t) => (
                <option key={t} value={t}>{ENTRY_TYPE_LABELS[t] || t}</option>
              ))}
            </select>
          )}
        </Field>
      )}
      {type === 'trial_purchase' && (
        <Field id="wiz-match" label="Match on">
          {(p) => (
            <select {...p} disabled={disabled} value={match || ''} onChange={(e) => dispatch({ type: 'setEntryMatch', match: e.target.value })}
              className="rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text">
              {TRIAL_MATCHES.map((m) => <option key={m} value={m}>{TRIAL_MATCH_LABELS[m] || m}</option>)}
            </select>
          )}
        </Field>
      )}
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-un1t-text">{entryDescription(entry)}</legend>
        {opts.loading && <Loading inline label="Loading options" />}
        {!opts.loading && opts.error && <p className="text-sm text-red-700" role="alert">{opts.error}</p>}
        {!opts.loading && !opts.error && options.length === 0 && (
          <p className="text-sm text-un1t-subtle">Nothing to pick from at this studio yet.</p>
        )}
        {!opts.loading && options.length > 0 && (
          <ul className="space-y-2">
            {options.map((o) => (
              <li key={o.value}>
                <label className="flex items-start gap-2 text-sm text-un1t-text">
                  <input type="checkbox" className="mt-0.5" disabled={disabled} checked={picked.has(o.value)} onChange={() => toggle(o.value)} />
                  <span>
                    {o.label}
                    {o.label !== o.value && <span className="ml-1 text-xs text-un1t-subtle">({o.value})</span>}
                    {o.hint && <span className="block text-xs text-un1t-subtle">{o.hint}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  )
}
