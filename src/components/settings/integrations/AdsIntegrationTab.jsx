'use client'

// ADS-REPORT.0 — Ads integration settings tab (per-location tokens).
//
// Unlike the sibling tabs that write straight to `locations.settings`
// via the browser Supabase client, `ad_accounts` is service-role-only
// (RLS denies the browser client) — everything here goes through the
// /api/settings/ads route built in ADS-REPORT.0's API task:
//   GET  /api/settings/ads?locationId=…  → masked rows
//   PUT  /api/settings/ads               → upsert one provider's row
//   POST /api/settings/ads/test          → live connection check
//       (endpoint lands in a later task; a 404/400 here is expected
//       and just surfaces as an error string, not a crash)
//
// Tokens are never echoed in plain: the GET response has them masked
// (`••••••••ttok`) plus a `has_access_token` boolean. We only send a
// fresh `access_token` in the PUT when the operator actually typed a
// new value (tracked per-card via `tokenEdited`) — the server ignores
// a re-submitted mask anyway (`isFreshSecret`), but there's no reason
// to send it.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Check, Loader2, Plug, Save } from 'lucide-react'
import { Field } from '@/components/ui'

const PROVIDERS = [
  { key: 'meta', label: 'Meta (Facebook & Instagram)', comingSoon: false },
  { key: 'tiktok', label: 'TikTok', comingSoon: true },
]

// `onChanged` (optional): called after a successful account save so a host
// surface (the Integrations hub drawer) can re-grade its own card without a
// full route refresh. When absent, the standalone location-tab behaviour is
// unchanged (router.refresh() re-runs the tab's server data + status dots).
export default function AdsIntegrationTab({ location, canEdit, onChanged }) {
  const router = useRouter()
  const [rows, setRows] = useState({}) // provider -> masked row (or null)
  const [recipients, setRecipients] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  async function load() {
    setLoading(true); setLoadError(null)
    try {
      const res = await fetch(`/api/settings/ads?locationId=${location.id}`, { credentials: 'same-origin' })
      const j = await res.json().catch(() => ({}))
      if (!j.success) throw new Error(j.error || 'Failed to load ad accounts')
      const byProvider = {}
      for (const row of j.data || []) byProvider[row.provider] = row
      setRows(byProvider)
      setRecipients((j.report_recipients || []).join(', '))
    } catch (e) {
      setLoadError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Connect the ad account(s) that report into this location&apos;s ads dashboard. Tokens are
        stored server-side and never shown in full once saved.
      </p>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5" /> {loadError}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          <ReportRecipientsSection
            locationId={location.id}
            recipients={recipients}
            setRecipients={setRecipients}
            canEdit={canEdit}
          />

          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p.key}
              locationId={location.id}
              provider={p.key}
              label={p.label}
              comingSoon={p.comingSoon}
              row={rows[p.key] || null}
              canEdit={canEdit}
              onSaved={(row) => {
                setRows((prev) => ({ ...prev, [p.key]: row }))
                if (onChanged) onChanged()
                else router.refresh()
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ReportRecipientsSection({ locationId, recipients, setRecipients, canEdit }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  async function save() {
    setSaving(true); setError(null); setSavedAt(null)
    try {
      const report_recipients = recipients.split(',').map((s) => s.trim()).filter(Boolean)
      const res = await fetch('/api/settings/ads', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, report_recipients }),
      })
      const j = await res.json().catch(() => ({}))
      if (!j.success) throw new Error(j.error || 'Failed to save')
      setRecipients((j.report_recipients || []).join(', '))
      setSavedAt(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-3">
      <h4 className="text-sm font-semibold text-un1t-text">Daily report recipients</h4>
      <p className="text-[11px] text-un1t-muted">
        Who gets the daily ads performance email. Empty = no report for this studio.
      </p>

      {!canEdit ? (
        <div className="text-xs text-un1t-subtle">
          Ads integration settings are owner/master-only.
        </div>
      ) : (
        <>
          <input
            type="text"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            disabled={saving}
            placeholder="owner@example.com, manager@example.com"
            className="w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text disabled:opacity-50"
          />

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
        </>
      )}
    </div>
  )
}

function ProviderCard({ locationId, provider, label, comingSoon, row, canEdit, onSaved }) {
  const [externalAccountId, setExternalAccountId] = useState(row?.external_account_id || '')
  const [accessToken, setAccessToken] = useState('')
  const [tokenEdited, setTokenEdited] = useState(false)
  const [isActive, setIsActive] = useState(row?.is_active ?? false)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // { success, name?, error? }

  async function save() {
    setSaving(true); setError(null); setSavedAt(null); setTestResult(null)
    try {
      const body = {
        locationId,
        provider,
        external_account_id: externalAccountId || null,
        is_active: isActive,
      }
      if (tokenEdited && accessToken) body.access_token = accessToken

      const res = await fetch('/api/settings/ads', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!j.success) throw new Error(j.error || 'Failed to save')

      setAccessToken('')
      setTokenEdited(false)
      setSavedAt(new Date())
      onSaved(j.data)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    setTesting(true); setTestResult(null)
    try {
      const res = await fetch('/api/settings/ads/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, provider }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) {
        setTestResult({ success: false, error: j.error || `Test connection failed (${res.status})` })
        return
      }
      setTestResult(j)
    } catch (e) {
      setTestResult({ success: false, error: e.message || 'Network error' })
    } finally {
      setTesting(false)
    }
  }

  const tokenPlaceholder = row?.has_access_token ? row.access_token : 'Not set'

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Plug size={14} className="text-un1t-subtle" />
          <h4 className="text-sm font-semibold text-un1t-text">{label}</h4>
        </div>
        {comingSoon && (
          <span className="bg-amber-500/10 text-amber-700 text-[10px] uppercase tracking-wide rounded px-2 py-0.5">
            Sync coming soon
          </span>
        )}
      </div>

      {comingSoon && (
        <p className="text-[11px] text-un1t-muted">
          Config is saved now so it&apos;s ready when TikTok sync ships — reporting isn&apos;t wired up yet.
        </p>
      )}

      {!canEdit ? (
        <div className="text-xs text-un1t-subtle">
          Ads integration settings are owner/master-only.
        </div>
      ) : (
        <>
          <Field id={`${provider}-account-id`} label="Account ID">
            {(props) => (
              <input
                {...props}
                type="text"
                value={externalAccountId}
                onChange={(e) => setExternalAccountId(e.target.value)}
                placeholder={provider === 'meta' ? 'act_1234567890' : 'External account ID'}
                className="w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text"
              />
            )}
          </Field>

          <Field
            id={`${provider}-access-token`}
            label="Access token"
            hint={row?.has_access_token ? 'Leave blank to keep the current token.' : undefined}
          >
            {(props) => (
              <input
                {...props}
                type="password"
                value={accessToken}
                onChange={(e) => { setAccessToken(e.target.value); setTokenEdited(true) }}
                placeholder={tokenPlaceholder}
                autoComplete="off"
                className="w-full bg-un1t-surface border border-un1t-border rounded-md px-3 py-2 text-sm font-mono text-un1t-text"
              />
            )}
          </Field>

          <div className="flex items-center justify-between border border-un1t-border rounded-md px-3 py-2">
            <div>
              <div className="text-sm text-un1t-text">Active</div>
              <div className="text-[11px] text-un1t-muted">Only active accounts are used for reporting sync.</div>
            </div>
            <button
              type="button"
              onClick={() => setIsActive((v) => !v)}
              className={`w-10 h-5 rounded-full transition-colors ${isActive ? 'bg-green-500' : 'bg-un1t-border'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {row?.last_sync_error && (
            <div className="bg-red-500/10 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
              <AlertCircle size={12} className="mt-0.5" /> Last sync error: {row.last_sync_error}
            </div>
          )}
          <div className="text-[11px] text-un1t-muted">
            Last synced: {row?.last_synced_at ? new Date(row.last_synced_at).toLocaleString() : 'Never'}
          </div>

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
          {testResult && (
            testResult.success ? (
              <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-xs rounded-md p-2 inline-flex items-center gap-2">
                <Check size={12} /> Connected{testResult.name ? ` — ${testResult.name}` : ''}
              </div>
            ) : (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 flex items-start gap-2">
                <AlertCircle size={12} className="mt-0.5" /> {testResult.error || 'Test connection failed'}
              </div>
            )
          )}

          <div className="flex items-center justify-between pt-2 border-t border-un1t-border/40">
            <button
              type="button"
              onClick={testConnection}
              disabled={testing || !row}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-un1t-border text-un1t-subtle text-sm hover:text-un1t-text disabled:opacity-50"
              title={!row ? 'Save the account before testing the connection' : undefined}
            >
              {testing
                ? <><Loader2 size={12} className="animate-spin" /> Testing…</>
                : 'Test connection'
              }
            </button>
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
        </>
      )}
    </div>
  )
}
