'use client'

// Twilio / SMS integration tab. Per the SETTINGS.1 follow-up, moved
// out of LocationForm so all the integration-y per-location config
// lives in one place. Twilio account creds (account SID, auth token)
// stay as global env vars — only the alpha sender ID is per-location.
//
// validateAlphaSenderId runs the same app-side check that the
// original LocationForm did so the operator gets an inline error
// before Twilio's send-time 21212 / 30002 rejection.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Save, Loader2, Check, AlertCircle } from 'lucide-react'
import { validateAlphaSenderId } from '@/lib/twilio'

export default function TwilioIntegrationTab({ location, canEdit }) {
  const router = useRouter()

  const [senderId, setSenderId] = useState(location.twilio_alpha_sender_id || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    const trimmed = senderId.trim()
    if (trimmed) {
      const err = validateAlphaSenderId(trimmed)
      if (err) { setError(`Sender ID: ${err}`); setSaving(false); return }
    }
    const db = createBrowserClient()
    const { error: upErr } = await db
      .from('locations')
      .update({
        twilio_alpha_sender_id: trimmed || null,
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
        Only owners + masters can edit the Twilio sender ID.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-light">
        Twilio account credentials (Account SID + Auth Token) are global env vars
        managed in Vercel. Only the per-location <strong>alpha sender ID</strong> is
        configured here — that's the branded name (max 11 alphanumeric chars) shown on
        recipients' phones for SMS sent from this location. Leave blank to use the
        global <code className="text-[10px] mx-1 px-1 bg-un1t-black/40 rounded">TWILIO_FROM</code> fallback.
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

      <div>
        <label className="block text-xs text-un1t-light mb-1">Alpha Sender ID</label>
        <input
          type="text"
          value={senderId}
          onChange={e => setSenderId(e.target.value)}
          placeholder="e.g. UN1T or UN1THATCH"
          maxLength={11}
          pattern="[A-Za-z0-9]*"
          className="w-full max-w-xs bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono text-un1t-white"
        />
        <p className="text-[11px] text-un1t-mid mt-1">
          Max 11 chars, alphanumeric only (no spaces or punctuation). Some carriers
          require pre-registration of branded sender IDs — check Twilio's regional
          guidelines for IE/UK before going live.
        </p>
      </div>

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
