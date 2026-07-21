'use client'

// /admin/tenant-domains manager (SAAS-8). Add / toggle / delete rows
// in tenant_domains. The "mode" select covers the two brand shapes
// operators actually need — the marketing defaults (brand {}) and a
// locked-down payment-style config; anything bespoke is a row edit
// via the API (the brand column is validated jsonb, not a UI form).

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Field } from '@/components/ui'

const MODES = [
  {
    value: 'marketing',
    label: 'Marketing site (strays land on /welcome)',
    brand: undefined, // omit — the row's {} default is exactly this
  },
  {
    value: 'locked',
    label: 'Locked down (everything 404s until paths are allowlisted)',
    brand: { rootHandler: 'reject', fallbackHandler: 'reject', allowedPaths: [] },
  },
]

const CONTROL_CLASS = 'w-full rounded-lg border border-un1t-border bg-un1t-surface px-3 py-2 text-sm text-un1t-text'

function modeSummary(brand) {
  const cfg = brand && typeof brand === 'object' ? brand : {}
  if (!Object.keys(cfg).length) return 'Marketing defaults'
  const root = cfg.rootHandler || 'rewrite'
  const fallback = cfg.fallbackHandler || 'rewrite'
  return `root: ${root} · strays: ${fallback}`
}

export default function TenantDomainsAdmin({ initialDomains, organizations, locations = [], legacyDomains = [] }) {
  const [rows, setRows] = useState(initialDomains)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const orgName = (row) =>
    row.organizations?.name
    || organizations.find((o) => o.id === row.organization_id)?.name
    || row.organization_id

  // "Whole org" when unscoped; the studio name otherwise (from the GET
  // embed, or the preloaded locations list for a just-created row).
  const locName = (row) =>
    !row.location_id
      ? 'Whole org'
      : row.locations?.name
        || locations.find((l) => l.id === row.location_id)?.name
        || row.location_id

  async function call(url, options) {
    setError(null)
    try {
      const res = await fetch(url, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const json = await res.json()
      if (!json.success) {
        setError(json.error || 'Request failed')
        return null
      }
      return json.data
    } catch {
      setError('Network error — nothing saved')
      return null
    }
  }

  async function add({ hostname, organizationId, locationId, mode }) {
    const brand = MODES.find((m) => m.value === mode)?.brand
    const data = await call('/api/admin/tenant-domains', {
      method: 'POST',
      body: JSON.stringify({
        hostname,
        organization_id: organizationId,
        ...(locationId ? { location_id: locationId } : {}),
        ...(brand ? { brand } : {}),
      }),
    })
    if (!data) return false
    setRows((rs) => [...rs, data].sort((a, b) => a.hostname.localeCompare(b.hostname)))
    return true
  }

  async function toggle(row) {
    setBusyId(row.id)
    const data = await call(`/api/admin/tenant-domains/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !row.active }),
    })
    setBusyId(null)
    if (data) setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...data } : r)))
  }

  async function remove(row) {
    if (!window.confirm(`Remove ${row.hostname}? The domain falls back to the CRM login gate.`)) return
    setBusyId(row.id)
    const data = await call(`/api/admin/tenant-domains/${row.id}`, { method: 'DELETE' })
    setBusyId(null)
    if (data) setRows((rs) => rs.filter((r) => r.id !== row.id))
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-500/10 p-3 text-sm text-red-700">{error}</p>
      )}

      <AddForm organizations={organizations} locations={locations} onAdd={add} />

      <div className="overflow-hidden rounded-xl border border-un1t-border bg-un1t-surface">
        <table className="w-full text-sm">
          <thead className="bg-un1t-border/30 text-left text-xs uppercase text-un1t-subtle">
            <tr>
              <th className="px-4 py-2">Hostname</th>
              <th className="px-4 py-2">Organization</th>
              <th className="px-4 py-2">Location</th>
              <th className="px-4 py-2">Routing</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-un1t-muted italic">
                  No tenant domains yet. The legacy hostnames below are managed in code (src/lib/brands.js).
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-un1t-border">
                <td className="px-4 py-3 font-medium">{row.hostname}</td>
                <td className="px-4 py-3">{orgName(row)}</td>
                <td className="px-4 py-3 text-un1t-subtle">{locName(row)}</td>
                <td className="px-4 py-3 text-un1t-subtle">{modeSummary(row.brand)}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    row.active ? 'bg-emerald-500/10 text-emerald-700' : 'bg-neutral-500/10 text-neutral-700'
                  }`}>
                    {row.active ? 'active' : 'inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggle(row)}
                    loading={busyId === row.id}
                    className="mr-1"
                  >
                    {row.active ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => remove(row)}
                    disabled={busyId === row.id}
                    aria-label={`Delete ${row.hostname}`}
                  />
                </td>
              </tr>
            ))}

            {/* Legacy in-code hostnames — READ-ONLY. Pulled from the
                BRANDS registry (+ CRM default) so the operator sees the
                full domain picture; these are never writable via the
                API (mig 415 forbids seeding them). */}
            {legacyDomains.length > 0 && (
              <>
                <tr className="border-t border-un1t-border bg-un1t-border/20">
                  <td colSpan={6} className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-un1t-subtle">
                    Managed in code · read-only
                  </td>
                </tr>
                {legacyDomains.map((ld) => (
                  <tr key={`legacy-${ld.key}`} className="border-t border-un1t-border bg-un1t-border/5 text-un1t-subtle">
                    <td className="px-4 py-3 font-medium">
                      {ld.hostname}
                      {ld.extraHostnames?.length > 0 && (
                        <span className="ml-2 text-xs text-un1t-muted">+ {ld.extraHostnames.join(', ')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{ld.label}</td>
                    <td className="px-4 py-3">—</td>
                    <td className="px-4 py-3">{ld.description || 'in code'}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-neutral-500/10 px-2 py-0.5 text-xs font-semibold text-neutral-700">
                        read-only
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-un1t-muted whitespace-nowrap">
                      in code
                    </td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AddForm({ organizations, locations, onAdd }) {
  const [hostname, setHostname] = useState('')
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id || '')
  const [locationId, setLocationId] = useState('') // '' = whole organisation
  const [mode, setMode] = useState('marketing')
  const [saving, setSaving] = useState(false)

  // The picked org's studios (empty '' option = whole organisation).
  const orgLocations = locations.filter((l) => l.organization_id === organizationId)

  function onOrgChange(id) {
    setOrganizationId(id)
    setLocationId('') // org changed → its locations differ; reset to whole-org
  }

  async function submit(e) {
    e.preventDefault()
    if (!hostname.trim() || !organizationId || saving) return
    setSaving(true)
    const ok = await onAdd({
      hostname: hostname.trim(),
      organizationId,
      locationId: locationId || null,
      mode,
    })
    setSaving(false)
    if (ok) { setHostname(''); setLocationId('') }
  }

  return (
    <form onSubmit={submit} className="mb-6 flex flex-wrap items-end gap-3">
      <Field id="td-hostname" label="Hostname" className="w-64">
        {(props) => (
          <input
            {...props}
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="members.acmegym.ie"
            className={CONTROL_CLASS}
          />
        )}
      </Field>
      <Field id="td-org" label="Organization" className="w-56">
        {(props) => (
          <select
            {...props}
            value={organizationId}
            onChange={(e) => onOrgChange(e.target.value)}
            className={CONTROL_CLASS}
          >
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        )}
      </Field>
      <Field id="td-location" label="Location (optional)" className="w-56">
        {(props) => (
          <select
            {...props}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={CONTROL_CLASS}
          >
            <option value="">Whole organisation</option>
            {orgLocations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
      </Field>
      <Field id="td-mode" label="Mode" className="w-96 max-w-full">
        {(props) => (
          <select
            {...props}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className={CONTROL_CLASS}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        )}
      </Field>
      <Button
        type="submit"
        icon={Plus}
        loading={saving}
        disabled={!hostname.trim() || !organizationId}
      >
        Add domain
      </Button>
    </form>
  )
}
