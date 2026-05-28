'use client'

// Master-only matrix view: locations × per-location feature gates,
// grouped by organization. Mirrors LocationFeatures.jsx in semantics
// (same toggle pattern, same WEB/MOBILE separation, same notification-
// keys-excluded rule via isFeatureGatedByLocation), but renders a
// grid instead of one location at a time.
//
// Each cell write is independent — clicking a toggle updates that one
// (location, feature) pair via the browser Supabase client. Optimistic
// update with revert-on-failure. Per-cell busy state so multiple
// simultaneous toggles don't lock each other out.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Check, AlertCircle } from 'lucide-react'
import { WEB_PERMISSIONS, MOBILE_PERMISSIONS, isFeatureGatedByLocation } from '@shared/permissions'

// Mirror of isFeatureEnabledAtLocation in shared/permissions.js —
// keep inline for self-containment so the table doesn't crash if
// the helper signature shifts.
function isOn(features, key) {
  return features?.[key] !== false
}

function ToggleCell({ on, busy, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`shrink-0 w-8 h-4 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-green-500' : 'bg-un1t-border'}`}
      aria-pressed={on}
      title={on ? 'Enabled — click to disable' : 'Disabled — click to enable'}
    >
      <div className={`w-3 h-3 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  )
}

export default function AdminFeatureMatrix({ organizations, locationsByOrg }) {
  const router = useRouter()

  // Local copy of every location's features map, keyed by location.id.
  // Seeded from the server-rendered locations on mount.
  const initialFeatures = {}
  for (const orgId of Object.keys(locationsByOrg)) {
    for (const loc of locationsByOrg[orgId]) {
      initialFeatures[loc.id] = loc.features || {}
    }
  }
  const [featuresByLoc, setFeaturesByLoc] = useState(initialFeatures)
  const [busyCell, setBusyCell] = useState(null)        // `${locationId}::${featureKey}`
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Filter to location-gated features only — notification preferences
  // are personal and don't belong on a location-scoped matrix.
  const webFeatures = WEB_PERMISSIONS.filter(p => isFeatureGatedByLocation(p.key))
  const mobileFeatures = MOBILE_PERMISSIONS.filter(p => isFeatureGatedByLocation(p.key))

  async function toggle(locationId, featureKey) {
    const cellKey = `${locationId}::${featureKey}`
    setBusyCell(cellKey)
    setError(null)

    const current = featuresByLoc[locationId] || {}
    const next = { ...current, [featureKey]: !isOn(current, featureKey) }

    // Optimistic update — revert on failure. Save goes through the
    // master-only endpoint so the policy is enforced server-side
    // even though /admin/* itself is master-gated.
    setFeaturesByLoc({ ...featuresByLoc, [locationId]: next })
    try {
      const r = await fetch(`/api/locations/${locationId}/features`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: next }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(`${locationId}: ${j.error || `Save failed (${r.status})`}`)
        setFeaturesByLoc({ ...featuresByLoc, [locationId]: current })
        return
      }
      setSavedAt(new Date())
      router.refresh()
    } catch (e) {
      setError(`${locationId}: ${e.message || 'Network error'}`)
      setFeaturesByLoc({ ...featuresByLoc, [locationId]: current })
    } finally {
      setBusyCell(null)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
      {error && (
        <div className="mb-3 bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="mb-3 text-[11px] text-green-700 inline-flex items-center gap-1">
          <Check size={11} /> Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <FeatureSection
        title="Web features"
        features={webFeatures}
        organizations={organizations}
        locationsByOrg={locationsByOrg}
        featuresByLoc={featuresByLoc}
        busyCell={busyCell}
        onToggle={toggle}
      />

      <div className="h-6" />

      <FeatureSection
        title="Mobile features"
        features={mobileFeatures}
        organizations={organizations}
        locationsByOrg={locationsByOrg}
        featuresByLoc={featuresByLoc}
        busyCell={busyCell}
        onToggle={toggle}
      />
    </div>
  )
}

function FeatureSection({
  title,
  features,
  organizations,
  locationsByOrg,
  featuresByLoc,
  busyCell,
  onToggle,
}) {
  if (features.length === 0) return null

  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
        {title}
      </h4>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-un1t-surface text-left p-2 font-medium text-un1t-subtle min-w-[180px]">
                Location
              </th>
              {features.map(f => (
                <th
                  key={f.key}
                  className="p-2 text-left font-medium text-un1t-subtle whitespace-nowrap"
                  title={f.hint || ''}
                >
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {organizations.map(org => {
              const locs = locationsByOrg[org.id] || []
              if (locs.length === 0) return null
              return (
                <FeatureOrgRows
                  key={org.id}
                  org={org}
                  locations={locs}
                  features={features}
                  featuresByLoc={featuresByLoc}
                  busyCell={busyCell}
                  onToggle={onToggle}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function FeatureOrgRows({ org, locations, features, featuresByLoc, busyCell, onToggle }) {
  return (
    <>
      <tr>
        <td
          colSpan={features.length + 1}
          className="sticky left-0 bg-un1t-border/30 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle"
        >
          <div className="inline-flex items-center gap-1.5">
            <Building2 size={11} /> {org.name}
          </div>
        </td>
      </tr>
      {locations.map(loc => (
        <tr key={loc.id} className="hover:bg-un1t-border/10">
          <td className="sticky left-0 z-10 bg-un1t-surface px-2 py-1.5 font-medium text-un1t-text whitespace-nowrap">
            {loc.name}
          </td>
          {features.map(f => {
            const cellKey = `${loc.id}::${f.key}`
            const on = (featuresByLoc[loc.id]?.[f.key]) !== false
            return (
              <td key={f.key} className="px-2 py-1.5">
                <ToggleCell
                  on={on}
                  busy={busyCell === cellKey}
                  onClick={() => onToggle(loc.id, f.key)}
                />
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}
