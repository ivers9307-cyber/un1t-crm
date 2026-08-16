'use client'

// Per-location feature gates (migration 032). MASTER-ONLY edit
// (audit Nov 2026 — was owner-or-master, RLS still let owners
// touch the column). Saves now go through PUT /api/locations/[id]/features
// which gates on canEditLocationFeatures().
//
// Toggling a feature OFF here disables it for every user at this
// location, regardless of their role default or per-user permission.
// Notification preferences (notify_*) are NOT location-gated — they
// stay user-controlled — and are filtered out below.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, AlertCircle, ChevronRight } from 'lucide-react'
import { WEB_PERMISSIONS, MOBILE_PERMISSIONS, isFeatureGatedByLocation, isFeatureEnabledAtLocation } from '@shared/permissions'
import { BUNDLE_KEYS, BUNDLE_LABELS } from '@shared/permission-bundles'

// BUNDLES.5 — was a hand-rolled `isOn(features, key)` mirror of
// isFeatureEnabledAtLocation's polarity; now calls the REAL helper so
// this UI can never drift from the resolver it's previewing (it also
// now needs to account for the bundle layer, not just the individual
// key, and re-deriving that here would be exactly the kind of second
// implementation the bundle layer's own polarity tests exist to catch
// drift in).
function isOn(features, key) {
  return isFeatureEnabledAtLocation({ features }, key)
}

function FeatureToggle({ on, onToggle, busy, label, hint }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-un1t-text">{label}</div>
        {hint && <div className="text-[11px] text-un1t-subtle mt-0.5">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className={`shrink-0 w-10 h-5 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-green-500' : 'bg-un1t-border'}`}
        aria-pressed={on}
      >
        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

export default function LocationFeatures({ location }) {
  const router = useRouter()
  const [features, setFeatures] = useState(location.features || {})
  const [busyKey, setBusyKey] = useState(null)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Filter out notification keys — those are personal preferences,
  // not something a location admin should override.
  const webFeatures = WEB_PERMISSIONS.filter(p => isFeatureGatedByLocation(p.key))
  const mobileFeatures = MOBILE_PERMISSIONS.filter(p => isFeatureGatedByLocation(p.key))

  async function toggle(key) {
    setBusyKey(key); setError(null)
    const next = { ...features, [key]: !isOn(features, key) }
    // Optimistic update — revert on failure.
    setFeatures(next)
    try {
      const r = await fetch(`/api/locations/${location.id}/features`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: next }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Save failed (${r.status})`)
        setFeatures(features) // revert
        return
      }
      setSavedAt(new Date())
      // Refresh server components so the gate takes effect immediately
      // for the operator (their own activeLocation will pick up the
      // new features map on next render).
      router.refresh()
    } catch (e) {
      setError(e.message || 'Network error')
      setFeatures(features)
    } finally {
      setBusyKey(null)
    }
  }

  // SETTINGS.1 follow-up — collapsed by default. The full toggle list
  // is long (20 web + ~15 mobile features); the operator usually opens
  // this section to flip one thing, not browse it. Using <details>
  // gives us accessible expand/collapse without React state plumbing.
  // `webFeaturesOpen` / `mobileFeaturesOpen` aren't strictly needed —
  // the native <details> element handles open state. We use a single
  // wrapper <details> around the whole component so one click expands
  // both sub-sections.

  return (
    <details className="bg-un1t-surface border border-un1t-border rounded-lg group">
      <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-un1t-text">Per-location feature toggles</div>
          <div className="text-xs text-un1t-subtle mt-0.5">
            {BUNDLE_KEYS.length} bundles + {webFeatures.length + mobileFeatures.length} fine-grained features — click to expand.
            Toggling off hides a feature for every user at this location.
          </div>
        </div>
        <ChevronRight size={14} className="text-un1t-subtle transition-transform group-open:rotate-90 shrink-0" />
      </summary>

      <div className="border-t border-un1t-border p-5 space-y-5">
        <div>
          <p className="text-xs text-un1t-subtle">
            Toggle features off to hide them for every user at this location.
            User-level permissions and role defaults are still applied <em>within</em> the features that are on.
          </p>
          {error && (
            <div className="mt-3 bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
              <AlertCircle size={12} className="mt-0.5" /> {error}
            </div>
          )}
          {savedAt && !error && (
            <div className="mt-3 text-[11px] text-green-500 inline-flex items-center gap-1">
              <Check size={11} /> Saved at {savedAt.toLocaleTimeString()}
            </div>
          )}
        </div>

        {/* BUNDLES.5 Task 3 — bundles render FIRST, above the
            fine-grained keys: this is the ≤8-flag SaaS provisioning
            surface most masters actually want, with the ~35
            fine-grained keys demoted to an "Advanced" details below. */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Bundles</h4>
          <p className="text-[11px] text-un1t-subtle mb-2">
            Each bundle gates a whole hub (or the Cars module) at once. Turning a bundle off hides
            every feature it owns, everywhere — including fine-grained keys below that also happen
            to belong to it.
          </p>
          <div className="divide-y divide-un1t-border/40 border border-un1t-border rounded-md px-3">
            {BUNDLE_KEYS.map(key => (
              <FeatureToggle
                key={`bundle-${key}`}
                on={isOn(features, key)}
                onToggle={() => toggle(key)}
                busy={busyKey === key}
                label={BUNDLE_LABELS[key]}
              />
            ))}
          </div>
        </section>

        <details>
          <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">
            Advanced — fine-grained feature keys
          </summary>

          <div className="space-y-5 mt-3">
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Web features</h4>
              <div className="divide-y divide-un1t-border/40 border border-un1t-border rounded-md px-3">
                {webFeatures.map(f => (
                  <FeatureToggle
                    key={`web-${f.key}`}
                    on={isOn(features, f.key)}
                    onToggle={() => toggle(f.key)}
                    busy={busyKey === f.key}
                    label={f.label}
                    hint={f.hint}
                  />
                ))}
              </div>
            </section>

            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Mobile features</h4>
              <p className="text-[11px] text-un1t-subtle mb-2">
                Notification preferences (per-user) are intentionally not listed here.
              </p>
              <div className="divide-y divide-un1t-border/40 border border-un1t-border rounded-md px-3">
                {mobileFeatures.map(f => (
                  <FeatureToggle
                    key={`mobile-${f.key}`}
                    on={isOn(features, f.key)}
                    onToggle={() => toggle(f.key)}
                    busy={busyKey === f.key}
                    label={f.label}
                    hint={f.hint}
                  />
                ))}
              </div>
            </section>
          </div>
        </details>
      </div>
    </details>
  )
}
