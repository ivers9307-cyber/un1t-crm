'use client'

// APIKEYS.2 — manage per-org API keys. Lists active/revoked keys, creates
// a new key (revealing the raw secret exactly once), and revokes. Built
// on the shared components/ui primitives (UI-FOUND.2).

import { useState } from 'react'
import { Copy, Check, Trash2, KeyRound, AlertTriangle } from 'lucide-react'
import { Button, Card, Field } from '@/components/ui'

function fmtDate(s) {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-IE', { day: '2-digit', month: 'short', year: 'numeric' }) } catch { return s }
}

export default function ApiKeysSettings({ initialKeys = [] }) {
  const [keys, setKeys] = useState(initialKeys)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [revealed, setRevealed] = useState(null) // { prefix, secret } shown once
  const [copied, setCopied] = useState(false)
  const [revokingId, setRevokingId] = useState(null)

  async function createKey() {
    if (!name.trim() || creating) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setRevealed({ prefix: j.key.key_prefix, secret: j.secret })
      setKeys((prev) => [{ ...j.key, last_used_at: null, revoked_at: null }, ...prev])
      setName('')
    } catch (e) {
      setError(e.message || 'Failed to create key')
    } finally {
      setCreating(false)
    }
  }

  async function revoke(id) {
    if (!confirm('Revoke this key? Any integration using it will immediately lose access. This cannot be undone.')) return
    setRevokingId(id)
    try {
      const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k)))
    } catch (e) {
      setError(e.message || 'Failed to revoke key')
    } finally {
      setRevokingId(null)
    }
  }

  function copySecret() {
    if (!revealed?.secret) return
    navigator.clipboard?.writeText(revealed.secret)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-6">
      {/* Create */}
      <Card title="Create an API key">
        <p className="text-xs text-un1t-subtle mb-3">
          Keys are scoped to this organization. Use them as a <code>Bearer</code> token from n8n or other
          integrations. The secret is shown once — store it somewhere safe.
        </p>
        <div className="flex items-end gap-2">
          <Field id="api-key-name" label="Name" className="flex-1">
            {(p) => (
              <input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. n8n lead-capture"
                className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
              />
            )}
          </Field>
          <Button icon={KeyRound} loading={creating} disabled={!name.trim()} onClick={createKey}>
            Create key
          </Button>
        </div>
        {error && (
          <p className="mt-2 text-xs text-stage-lost flex items-center gap-1"><AlertTriangle size={12} /> {error}</p>
        )}

        {revealed && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs text-amber-200 flex items-start gap-1.5 mb-2">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>Copy this now — it won&apos;t be shown again. We only store a hash.</span>
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all select-all rounded-md border border-un1t-border bg-un1t-bg px-2 py-1.5 font-mono text-xs text-un1t-text">
                {revealed.secret}
              </code>
              <Button variant="secondary" size="sm" icon={copied ? Check : Copy} onClick={copySecret}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* List */}
      <Card title="Keys" padding="none">
        {keys.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-un1t-subtle">No API keys yet.</p>
        ) : (
          <div className="divide-y divide-un1t-border/60">
            {keys.map((k) => {
              const revoked = !!k.revoked_at
              return (
                <div key={k.id} className="flex items-center gap-3 px-4 py-3">
                  <KeyRound size={16} className={revoked ? 'text-un1t-muted' : 'text-un1t-subtle'} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium truncate ${revoked ? 'text-un1t-muted line-through' : 'text-un1t-text'}`}>
                      {k.name}
                    </p>
                    <p className="text-[11px] text-un1t-subtle font-mono">
                      {k.key_prefix}…  ·  created {fmtDate(k.created_at)}  ·  last used {fmtDate(k.last_used_at)}
                      {revoked && `  ·  revoked ${fmtDate(k.revoked_at)}`}
                    </p>
                  </div>
                  {!revoked && (
                    <Button
                      variant="ghost"
                      size="icon"
                      icon={Trash2}
                      loading={revokingId === k.id}
                      onClick={() => revoke(k.id)}
                      title="Revoke key"
                      className="text-un1t-muted hover:text-stage-lost"
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}
