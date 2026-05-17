'use client'

// Sensibo / AC integration tab. Extracted from LocationForm as part
// of SETTINGS.1. Sensibo creds are top-level columns on the locations
// table (mig 103), not in settings JSONB — the original schema choice.
// AC defaults (mode/temp/fan/session) live alongside since they're
// the operational knobs for the same hardware.
//
// Master + owner can edit. Has a 'Load pods' button that pings the
// Sensibo API to enumerate pods using the entered key — operator
// picks the right pod ID from the resulting list rather than
// hunting through the Sensibo dashboard.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Save, Loader2, Check, AlertCircle, RefreshCw } from 'lucide-react'

export default function SensiboIntegrationTab({ location, canEdit }) {
  const router = useRouter()

  const [apiKey, setApiKey] = useState(location.sensibo_api_key || '')
  const [podId, setPodId] = useState(location.sensibo_pod_id || '')
  const [acDefaultMode, setAcDefaultMode] = useState(location.ac_default_mode || 'cool')
  const [acDefaultTemp, setAcDefaultTemp] = useState(location.ac_default_temp ?? 18)
  const [acDefaultFan, setAcDefaultFan] = useState(location.ac_default_fan || 'high')
  const [acSessionMinutes, setAcSessionMinutes] = useState(location.ac_session_minutes ?? 90)

  const [pods, setPods] = useState(null)
  const [podsLoading, setPodsLoading] = useState(false)
  const [podsError, setPodsError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  async function loadPods() {
    if (!apiKey.trim()) {
      setPodsError('Paste an API key first.')
      return
    }
    setPodsLoading(true); setPodsError(null)
    try {
      const url = `/api/studio-management/ac/pods?api_key=${encodeURIComponent(apiKey.trim())}`
      const r = await fetch(url, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Failed (${r.status})`)
      setPods(j.data || [])
    } catch (e) {
      setPodsError(e.message || 'Failed to fetch pods')
      setPods([])
    } finally {
      setPodsLoading(false)
    }
  }

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    const db = createBrowserClient()
    const { error: upErr } = await db
      .from('locations')
      .update({
        sensibo_api_key: apiKey.trim() || null,
        sensibo_pod_id: podId.trim() || null,
        ac_default_mode: acDefaultMode || 'cool',
        ac_default_temp: Number(acDefaultTemp) || 18,
        ac_default_fan: acDefaultFan || 'high',
        ac_session_minutes: Number(acSessionMinutes) || 90,
        updated_at: new Date().toISOString(),
      })
      .eq('id', location.id)
    setSaving(false)
    if (upErr) { setError(upErr.message); return }
    setSavedAt(new Date())
    router.refresh()
  }

  if (!canEdit) {
    return (
      <div className="text-xs text-un1t-light">
        Only owners + masters can edit Sensibo / AC settings.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-light">
        Sensibo controls the studio AC over the Sensibo Cloud API. API key is per-Sensibo-account;
        Pod ID is the specific AC unit at this location. The defaults below are applied
        whenever staff or a scheduled session triggers AC on.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-xs rounded-md p-2 inline-flex items-center gap-2">
          <Check size={12} /> Saved at {savedAt.toLocaleTimeString()}
        </div>
      )}

      <Field label="API Key" hint="From Sensibo Web → Profile → API Keys.">
        <input type="text" value={apiKey} onChange={e => setApiKey(e.target.value)}
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono text-un1t-white" />
      </Field>

      <div className="flex items-end gap-2">
        <Field label="Pod ID">
          <input type="text" value={podId} onChange={e => setPodId(e.target.value)}
            placeholder="e.g. abCd12Ef"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono text-un1t-white" />
        </Field>
        <button
          type="button"
          onClick={loadPods}
          disabled={podsLoading}
          className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-md border border-un1t-gray text-xs text-un1t-light hover:text-un1t-white disabled:opacity-50"
        >
          {podsLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Load pods
        </button>
      </div>
      {podsError && <p className="text-[11px] text-red-400 -mt-2">{podsError}</p>}
      {pods && pods.length > 0 && (
        <div className="border border-un1t-gray rounded-md divide-y divide-un1t-gray/40">
          {pods.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPodId(p.id)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-un1t-gray/30 ${
                p.id === podId ? 'bg-un1t-gray/40' : ''
              }`}
            >
              <div className="text-un1t-white">{p.room?.name || p.id}</div>
              <div className="text-[11px] text-un1t-mid font-mono">{p.id}</div>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Field label="Default mode">
          <select value={acDefaultMode} onChange={e => setAcDefaultMode(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white">
            <option value="cool">Cool</option>
            <option value="heat">Heat</option>
            <option value="fan">Fan</option>
            <option value="auto">Auto</option>
            <option value="dry">Dry</option>
          </select>
        </Field>
        <Field label="Default temp (°C)">
          <input type="number" min={14} max={30} value={acDefaultTemp}
            onChange={e => setAcDefaultTemp(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white" />
        </Field>
        <Field label="Default fan">
          <select value={acDefaultFan} onChange={e => setAcDefaultFan(e.target.value)}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white">
            <option value="auto">Auto</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </Field>
      </div>

      <Field label="Session length (minutes)" hint="Auto-off after this long if no one stops it manually.">
        <input type="number" min={15} max={240} value={acSessionMinutes}
          onChange={e => setAcSessionMinutes(e.target.value)}
          className="w-32 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white" />
      </Field>

      <div className="flex justify-end pt-2 border-t border-un1t-gray/40">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-un1t-white text-un1t-black text-sm font-semibold hover:bg-un1t-accent disabled:opacity-50"
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
    <div className="flex-1">
      <label className="block text-xs text-un1t-light mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-un1t-mid mt-1">{hint}</p>}
    </div>
  )
}
