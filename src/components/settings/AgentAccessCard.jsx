'use client'

// MCP.1 — the "Agent access" card on the Integrations hub: the organisation's
// switch for the staff MCP server (org_settings.mcp_enabled, default off), the
// connector URL staff paste into Claude, and how many people used it lately.
// The switch PUTs /api/settings/org-mcp (organisation admins only; the hub
// shows this card only for organisations the viewer administers).

import { useState } from 'react'
import { Copy, Check, Bot } from 'lucide-react'

/**
 * @param {object} props
 * @param {{ id: string, name?: string|null }} props.organization
 * @param {{ enabled: boolean, connectorUrl: string|null, people30d: number }|null} props.mcp
 *        null = the state could not be read (no switch is shown)
 * @param {boolean} [props.canManage]
 */
export default function AgentAccessCard({ organization, mcp, canManage = false }) {
  const [enabled, setEnabled] = useState(mcp?.enabled === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const url = mcp?.connectorUrl || null
  const people = mcp?.people30d ?? 0

  async function toggle() {
    if (!canManage || saving) return
    const next = !enabled
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/org-mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: organization.id, enabled: next }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        setError(json?.error || 'Could not save the switch just now.')
        return
      }
      setEnabled(json.data?.mcp_enabled === true)
    } catch {
      setError('Could not save the switch just now.')
    } finally {
      setSaving(false)
    }
  }

  async function copyUrl() {
    if (!url) return
    try {
      await navigator.clipboard?.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: the URL is on screen to select by hand.
    }
  }

  return (
    <div className="rounded-xl border border-un1t-border bg-white p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg grid place-items-center shrink-0 bg-un1t-surface text-un1t-text border border-un1t-border" aria-hidden="true">
          <Bot size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-un1t-text flex items-center gap-2 flex-wrap">
            Agent access
            {organization?.name && (
              <span className="text-[10px] font-semibold text-un1t-subtle bg-un1t-surface border border-un1t-border rounded px-1.5 py-px">
                {organization.name}
              </span>
            )}
          </h3>
          <p className="text-xs text-un1t-muted mt-0.5">Staff MCP server · Claude connector</p>
        </div>
        {mcp && (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            enabled ? 'bg-emerald-500/10 text-emerald-700' : 'bg-gray-500/10 text-gray-700'
          }`}>
            {enabled ? 'On' : 'Off'}
          </span>
        )}
      </div>

      {!mcp ? (
        <p className="text-xs text-amber-700">Could not load the agent access settings just now. Reload the page to try again.</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <span id={`agent-access-label-${organization.id}`} className="text-xs text-un1t-text">
              Let staff connect Claude and other agents to {organization?.name || 'this organisation'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-labelledby={`agent-access-label-${organization.id}`}
              disabled={!canManage || saving}
              onClick={toggle}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                enabled ? 'bg-emerald-600' : 'bg-un1t-border'
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {error && <p role="alert" className="text-xs text-red-700 bg-red-500/10 rounded px-2 py-1">{error}</p>}

          {url ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded border border-un1t-border bg-un1t-surface px-2 py-1 text-xs text-un1t-text">{url}</code>
              <button
                type="button"
                onClick={copyUrl}
                className="inline-flex items-center gap-1 rounded-md border border-un1t-border px-2 py-1 text-xs font-semibold text-un1t-text hover:bg-un1t-surface"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-amber-700">The connector URL is not available: NEXT_PUBLIC_APP_URL is not set.</p>
          )}

          {url && (
            <p className="text-xs text-un1t-subtle">
              In Claude: Settings → Connectors → Add custom connector → paste this URL. In Claude Code:{' '}
              <code className="text-un1t-text">claude mcp add --transport http repset {url}</code>
            </p>
          )}

          <p className="text-xs text-un1t-muted">
            {people === 1 ? '1 person used it in the last 30 days' : `${people} people used it in the last 30 days`}
          </p>
        </>
      )}
    </div>
  )
}
