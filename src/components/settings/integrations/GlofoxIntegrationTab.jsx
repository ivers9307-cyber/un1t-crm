'use client'

// Glofox integration tab. Extracted from the monolithic LocationForm
// as part of SETTINGS.1 — now writes its own slice of locations.settings
// JSONB independently of the location-details form. Existing helper
// /api/locations/[id]/glofox-memberships keeps powering the trial-
// membership dropdown.
//
// Auth: master + owner. Field semantics unchanged from LocationForm
// (GLOFOX1.6 + PIPELINE5.10 + GLOFOX3.1 — see comments below).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { buildTrialOptions } from '@/lib/glofox-trial-options'
import { parseTrainerNames, formatTrainerNames } from '@/lib/glofox-trainer-names'
import { Save, Loader2, Check, AlertCircle } from 'lucide-react'

export default function GlofoxIntegrationTab({ location, canEdit }) {
  const router = useRouter()
  const initial = location.settings?.glofox || {}

  const [branchId, setBranchId] = useState(initial.branch_id || '')
  const [apiKey, setApiKey] = useState(initial.api_key || '')
  const [apiToken, setApiToken] = useState(initial.api_token || '')
  const [webhookSecret, setWebhookSecret] = useState(initial.webhook_secret || '')
  const [namespace, setNamespace] = useState(initial.namespace || '')
  const [trialKey, setTrialKey] = useState(
    initial.trial_membership_id && initial.trial_plan_code
      ? `${initial.trial_membership_id}:${initial.trial_plan_code}`
      : ''
  )
  const [hiddenClasses, setHiddenClasses] = useState(
    Array.isArray(initial.hidden_class_keywords)
      ? initial.hidden_class_keywords.join(', ')
      : (initial.hidden_class_keywords || '')
  )
  // STUDIO-KPI.4 — trainer-id → name overrides, edited as "id = Name"
  // lines. Backs the scorecard's per-coach floor table when the Glofox
  // API can't resolve a trainer id itself.
  const [trainerNames, setTrainerNames] = useState(formatTrainerNames(initial.trainer_names))
  const [seenTrainers, setSeenTrainers] = useState([])

  const [memberships, setMemberships] = useState([])
  const [membershipsLoading, setMembershipsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Load trial-membership options when credentials are present.
  useEffect(() => {
    if (!branchId || !apiKey) { setMemberships([]); return }
    let cancelled = false
    async function load() {
      setMembershipsLoading(true)
      try {
        const r = await fetch(`/api/locations/${location.id}/glofox-memberships`, { cache: 'no-store' })
        const j = await r.json()
        if (cancelled) return
        // The route returns the catalogue under `memberships` (legacy
        // top-level key). Reading `j.data` (the wrong key) was the bug
        // that left the picker permanently empty.
        if (r.ok && j.success !== false) setMemberships(j.memberships || j.data || [])
      } catch {
        // Silently ignore — picker just shows what we have stored.
      } finally {
        if (!cancelled) setMembershipsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [location.id, branchId, apiKey])

  // Reference list: the trainer ids Glofox actually sent in the last 28
  // days + how each currently resolves. Without it the override field
  // is un-fillable — the opaque ids appear nowhere else in the UI.
  useEffect(() => {
    if (!branchId || !apiKey) { setSeenTrainers([]); return }
    let cancelled = false
    async function loadTrainers() {
      try {
        const r = await fetch(`/api/locations/${location.id}/glofox-trainers`, { cache: 'no-store' })
        const j = await r.json()
        if (!cancelled && r.ok && j.success) setSeenTrainers(j.data?.trainers || [])
      } catch {
        // Silently ignore — the textarea still works without the list.
      }
    }
    loadTrainers()
    return () => { cancelled = true }
  }, [location.id, branchId, apiKey])

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    const [trialMembershipId, trialPlanCode] = trialKey ? trialKey.split(':') : ['', '']
    const hiddenList = hiddenClasses.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    const trainerMap = parseTrainerNames(trainerNames)
    const db = createBrowserClient()
    // Re-read current settings so we merge rather than clobber any
    // other tab's slice. Tiny race window if two tabs save at the
    // same moment; acceptable for per-location config writes.
    const { data: row, error: readErr } = await db
      .from('locations').select('settings').eq('id', location.id).single()
    if (readErr) { setError(readErr.message); setSaving(false); return }
    const nextSettings = {
      ...(row?.settings || {}),
      glofox: (branchId || apiKey || apiToken || webhookSecret || namespace || trialMembershipId || hiddenList.length || trainerMap)
        ? {
            branch_id: branchId || null,
            api_key: apiKey || null,
            api_token: apiToken || null,
            webhook_secret: webhookSecret || null,
            namespace: namespace || null,
            trial_membership_id: trialMembershipId || null,
            trial_plan_code: trialPlanCode || null,
            hidden_class_keywords: hiddenList.length ? hiddenList : null,
            trainer_names: trainerMap,
          }
        : null,
    }
    const { error: upErr } = await db
      .from('locations')
      .update({ settings: nextSettings, updated_at: new Date().toISOString() })
      .eq('id', location.id)
    setSaving(false)
    if (upErr) { setError(upErr.message); return }
    setSavedAt(new Date())
    // INTEG-A2: re-sync this location's channel_connections registry
    // rows from the legacy fields just saved (fire-and-forget — the
    // registry write needs the service role, which lives server-side).
    fetch(`/api/locations/${location.id}/connections/refresh`, { method: 'POST' }).catch(() => {})
    router.refresh()
  }

  if (!canEdit) {
    return (
      <div className="text-xs text-un1t-subtle">
        Only owners + masters can edit Glofox credentials.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Glofox is the gym-side member + booking source. The three-header auth (Branch ID
        + API Key + API Token) is required by Glofox v3; the webhook secret signs incoming
        Glofox webhooks (HMAC-SHA256). The namespace is the value Glofox sends in
        <code className="text-[10px] mx-1 px-1 bg-un1t-bg/40 rounded">/Analytics/report</code>
        responses — set it once or the report endpoint silently returns empty.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-xs rounded-md p-2 inline-flex items-center gap-2">
          <Check size={12} /> Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <Field label="Branch ID">
        <input type="text" value={branchId} onChange={e => setBranchId(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
      </Field>
      <Field label="API Key">
        <input type="text" value={apiKey} onChange={e => setApiKey(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
      </Field>
      <Field label="API Token">
        <input type="text" value={apiToken} onChange={e => setApiToken(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
      </Field>
      <Field label="Webhook Secret">
        <input type="text" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
      </Field>
      <Field label="Namespace" hint="Required for /Analytics/report queries. Glofox provides this on request.">
        <input type="text" value={namespace} onChange={e => setNamespace(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text" />
      </Field>

      <Field
        label="Trial membership"
        hint="Auto-attached when the CRM creates a Glofox account for a new contact (booking/event opt-in)."
      >
        <select
          value={trialKey}
          onChange={e => setTrialKey(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          <option value="">— None —</option>
          {buildTrialOptions(memberships, trialKey).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {membershipsLoading && <p className="text-[11px] text-un1t-muted mt-1">Loading membership list…</p>}
      </Field>

      <Field
        label="Hide classes from public booking"
        hint="Comma- or line-separated name keywords. Any class whose name contains one is hidden from the public /start picker AND can't be booked there (e.g. EL1TES, OPEN GYM). Case-insensitive; leave blank to show every class."
      >
        <textarea
          value={hiddenClasses}
          onChange={e => setHiddenClasses(e.target.value)}
          rows={2}
          placeholder="EL1TES, OPEN GYM"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        />
      </Field>

      <Field
        label="Trainer names"
        hint="One per line: trainerId = Name. Glofox class events carry only opaque trainer IDs — this map (or the Glofox API, when it can) turns them into the coach names the Studio scorecard groups by. Entries here override API-resolved names."
      >
        <textarea
          value={trainerNames}
          onChange={e => setTrainerNames(e.target.value)}
          rows={3}
          placeholder="61a38e7d0cf1970aae0fb3a9 = Jess Murphy"
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text"
        />
        {seenTrainers.length > 0 && (
          <div className="mt-2 text-[11px] text-un1t-muted space-y-0.5">
            <p className="font-semibold">Seen in the timetable (last 28 days):</p>
            {seenTrainers.map(t => (
              <p key={t.id} className="font-mono">
                {t.id} — {t.name
                  ? <>{t.name} <span className="text-un1t-subtle">({t.source === 'override' ? 'mapped here' : 'from Glofox'}, {t.classes} classes)</span></>
                  : <span className="text-amber-700">unresolved — add a line above ({t.classes} classes)</span>}
              </p>
            ))}
          </div>
        )}
      </Field>

      <div className="flex justify-end pt-2 border-t border-un1t-border/40">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-text text-un1t-bg text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
        >
          {saving
            ? <><Loader2 size={12} className="animate-spin" /> Saving…</>
            : <><Save size={12} /> Save</>
          }
        </button>
      </div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs text-un1t-subtle mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-muted mt-1">{hint}</p>}
    </div>
  )
}
