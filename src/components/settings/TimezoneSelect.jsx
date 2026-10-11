'use client'

// TZ.2 — the location timezone picker. Searchable; the common zones first,
// then every zone the browser knows (D1 = A), each with its current UTC
// offset; and the D8 hint when the zone looks wrong for the country (a
// warning, never a block). The value is validated again on the server
// (canonicalZone in POST /api/locations) and in the DB (mig 719), so this is
// the convenience, not the fence.

import { useId, useMemo, useState, useSyncExternalStore } from 'react'
import { COMMON_ZONES, allZones, countryZoneMismatch, filterZones, zoneOffsetLabel } from '@/lib/timezone-options'

// The full zone list comes from the RUNTIME's Intl, and Node's and the
// browser's can differ (Safari spells some links differently), so the server
// render and the hydrating render show only the common zones (+ the value);
// the full list appears once hydrated. No setState-in-effect needed.
const noop = () => () => {}
const useHydrated = () => useSyncExternalStore(noop, () => true, () => false)

const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted'
const display = (z) => z.replace(/_/g, ' ')

/**
 * @param {{ value: string, onChange: (zone: string) => void, country?: string,
 *           label?: string, nowMs?: number }} props
 */
export default function TimezoneSelect({ value, onChange, country, label = 'Timezone', nowMs }) {
  const id = useId()
  const [query, setQuery] = useState('')
  const hydrated = useHydrated()
  const zones = hydrated ? allZones() : COMMON_ZONES
  // One offset label per zone, computed once per render clock (the picker opens
  // for seconds, so a stale offset across a DST instant is harmless).
  const at = nowMs ?? null
  const labels = useMemo(() => {
    const ms = at ?? Date.now()
    return new Map(zones.map((z) => [z, zoneOffsetLabel(z, ms)]))
  }, [zones, at])
  const optionLabel = (z) => {
    const off = labels.get(z) ?? zoneOffsetLabel(z, at ?? Date.now())
    return off ? `${display(z)} (${off})` : display(z)
  }

  const matches = filterZones(zones, query)
  const searching = matches !== zones
  // The current value stays in the list so the select never shows a value it
  // lacks (a search that filtered it out, or a zone outside COMMON_ZONES
  // before hydration).
  const keepValue = (list) => (value && !list.includes(value) ? [value, ...list] : list)
  const shown = searching ? keepValue(matches) : null
  const common = new Set(COMMON_ZONES)
  const rest = zones.filter((z) => !common.has(z))
  if (value && !common.has(value) && !rest.includes(value)) rest.unshift(value)
  const hint = countryZoneMismatch(country, value)

  return (
    <div>
      <label htmlFor={id} className="block text-sm mb-1.5">{label} *</label>
      <input
        type="search"
        aria-label="Search timezones"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search, e.g. New York"
        className={`${inputCls} mb-2`}
      />
      <select
        id={id}
        required
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      >
        {searching ? (
          <>
            {shown.map((z) => <option key={z} value={z}>{optionLabel(z)}</option>)}
            {matches.length === 0 && <option value="" disabled>No timezone matches “{query.trim()}”</option>}
          </>
        ) : (
          <>
            <optgroup label="Common">
              {COMMON_ZONES.map((z) => <option key={z} value={z}>{optionLabel(z)}</option>)}
            </optgroup>
            {rest.length > 0 && (
              <optgroup label="All timezones">
                {rest.map((z) => <option key={z} value={z}>{optionLabel(z)}</option>)}
              </optgroup>
            )}
          </>
        )}
      </select>
      {hint && (
        <p role="status" className="text-xs text-amber-700 mt-1">{hint}</p>
      )}
    </div>
  )
}
