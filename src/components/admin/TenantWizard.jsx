'use client'

// SAAS4-P2/P3 — the tenant provisioning wizard body. See the page
// header for the route map. Each step submits to an existing API
// route, then advances by writing progress into the URL query so the
// flow is refresh-safe and resumable.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toSlug } from '@/lib/slug'
import { deriveWizardState, WIZARD_STEPS } from '@/lib/tenant-wizard'
import { Building2, MapPin, UserPlus, Palette, Globe, CheckCircle2 } from 'lucide-react'

const STEP_ICONS = { org: Building2, location: MapPin, owner: UserPlus, branding: Palette, domain: Globe, done: CheckCircle2 }

async function postJson(url, method, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return json || { success: false, error: `HTTP ${res.status}` }
  } catch {
    return { success: false, error: 'Network error — try again.' }
  }
}

export default function TenantWizard({ initialParams }) {
  const router = useRouter()
  const [params, setParams] = useState(initialParams)
  const { step, orgId, locationId } = deriveWizardState(params)

  // Advance = merge new params + reflect them in the URL (resume state).
  function advance(patch) {
    const next = { ...params, ...patch }
    setParams(next)
    const qs = new URLSearchParams(next).toString()
    router.replace(`/admin/tenants/new?${qs}`)
  }

  const stepIndex = WIZARD_STEPS.findIndex((s) => s.key === step)

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-semibold mb-1">New tenant</h1>
      <p className="text-sm text-un1t-subtle mb-6">
        Concierge setup: each step saves for real, so you can stop and resume any time — this page
        remembers where you got to.
      </p>

      {/* Stepper */}
      <ol className="flex flex-wrap gap-2 mb-8">
        {WIZARD_STEPS.map((s, i) => {
          const Icon = STEP_ICONS[s.key]
          const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo'
          return (
            <li
              key={s.key}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border ${
                state === 'done'
                  ? 'bg-green-500/10 text-green-700 border-transparent'
                  : state === 'current'
                    ? 'bg-un1t-text text-un1t-bg border-transparent'
                    : 'bg-un1t-surface text-un1t-subtle border-un1t-border'
              }`}
            >
              <Icon size={12} /> {s.label}
            </li>
          )
        })}
      </ol>

      {step === 'org' && <OrgStep onDone={(id) => advance({ org: id })} />}
      {step === 'location' && <LocationStep orgId={orgId} onDone={(id) => advance({ loc: id })} />}
      {step === 'owner' && <OwnerStep locationId={locationId} onDone={() => advance({ invited: '1' })} />}
      {step === 'branding' && (
        <BrandingStep orgId={orgId} onDone={() => advance({ branded: '1' })} onSkip={() => advance({ branded: 'skip' })} />
      )}
      {step === 'domain' && (
        <DomainStep orgId={orgId} onDone={() => advance({ domain: '1' })} onSkip={() => advance({ domain: 'skip' })} />
      )}
      {step === 'done' && <DoneStep orgId={orgId} />}
    </div>
  )
}

function StepCard({ title, hint, children }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
      <div className="text-base font-medium mb-1">{title}</div>
      {hint && <p className="text-xs text-un1t-subtle mb-4 max-w-lg">{hint}</p>}
      {children}
    </div>
  )
}

function ErrorNote({ error }) {
  if (!error) return null
  return (
    <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-3">
      {error}
    </div>
  )
}

function inputCls() {
  return 'mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm'
}

function PrimaryButton({ busy, children }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="bg-un1t-text text-un1t-bg text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-50"
    >
      {busy ? 'Saving…' : children}
    </button>
  )
}

function SkipButton({ onSkip }) {
  return (
    <button
      type="button"
      onClick={onSkip}
      className="text-sm text-un1t-subtle hover:text-un1t-text px-3 py-2"
    >
      Skip for now
    </button>
  )
}

function OrgStep({ onDone }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const json = await postJson('/api/admin/organizations', 'POST', { name: name.trim() })
    if (!json.success) {
      setError(json.error || 'Could not create the organisation.')
      setBusy(false)
      return
    }
    onDone(json.data.id)
  }

  return (
    <StepCard
      title="Create the organisation"
      hint="The tenant company — the unit that owns locations, branding, plans, and (later) the bill."
    >
      <form onSubmit={submit}>
        <ErrorNote error={error} />
        <label className="block text-sm mb-4 max-w-sm">
          <span>Company name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required className={inputCls()} placeholder="FitCo Dublin" />
          {name.trim() && <span className="text-xs text-un1t-subtle">Slug: {toSlug(name) || '—'}</span>}
        </label>
        <PrimaryButton busy={busy}>Create organisation</PrimaryButton>
      </form>
    </StepCard>
  )
}

function LocationStep({ orgId, onDone }) {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    // Ireland-only v1 (settled): timezone/country use the route defaults.
    const json = await postJson('/api/locations', 'POST', {
      name: name.trim(),
      organization_id: orgId,
      address: address.trim() || null,
    })
    if (!json.success) {
      setError(json.error || 'Could not create the location.')
      setBusy(false)
      return
    }
    onDone(json.data.id)
  }

  return (
    <StepCard
      title="Create the first location"
      hint="Seeds the full pipeline automatically. More locations can be added later from Settings."
    >
      <form onSubmit={submit}>
        <ErrorNote error={error} />
        <label className="block text-sm mb-3 max-w-sm">
          <span>Studio name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required className={inputCls()} placeholder="FitCo Ranelagh" />
        </label>
        <label className="block text-sm mb-4 max-w-sm">
          <span>Address (optional)</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls()} />
        </label>
        <PrimaryButton busy={busy}>Create location</PrimaryButton>
      </form>
    </StepCard>
  )
}

function OwnerStep({ locationId, onDone }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const json = await postJson('/api/staff', 'POST', {
      email: email.trim().toLowerCase(),
      full_name: fullName.trim(),
      assignments: [{ location_id: locationId, role: 'owner', is_default: true }],
    })
    if (!json.success) {
      setError(json.error || 'Could not send the invite.')
      setBusy(false)
      return
    }
    onDone()
  }

  return (
    <StepCard
      title="Invite the owner"
      hint="They get an email invite and set their own password. Owners manage their studio's staff, settings and branding themselves."
    >
      <form onSubmit={submit}>
        <ErrorNote error={error} />
        <label className="block text-sm mb-3 max-w-sm">
          <span>Full name</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} required className={inputCls()} />
        </label>
        <label className="block text-sm mb-4 max-w-sm">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={inputCls()} />
        </label>
        <PrimaryButton busy={busy}>Send invite</PrimaryButton>
      </form>
    </StepCard>
  )
}

function BrandingStep({ orgId, onDone, onSkip }) {
  const [companyName, setCompanyName] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const json = await postJson('/api/settings/org-branding', 'PUT', {
      organization_id: orgId,
      company_name: companyName.trim() || null,
      logo_url: logoUrl.trim() || null,
    })
    if (!json.success) {
      setError(json.error || 'Could not save branding.')
      setBusy(false)
      return
    }
    onDone()
  }

  return (
    <StepCard
      title="Branding defaults"
      hint="Org-level name and logo — every location inherits these until it sets its own. The owner can change them later."
    >
      <form onSubmit={submit}>
        <ErrorNote error={error} />
        <label className="block text-sm mb-3 max-w-sm">
          <span>Display name</span>
          <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} className={inputCls()} placeholder="FitCo" />
        </label>
        <label className="block text-sm mb-4 max-w-sm">
          <span>Logo URL</span>
          <input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} className={inputCls()} placeholder="https://…/logo.png" />
        </label>
        <div className="flex items-center gap-2">
          <PrimaryButton busy={busy}>Save branding</PrimaryButton>
          <SkipButton onSkip={onSkip} />
        </div>
      </form>
    </StepCard>
  )
}

function DomainStep({ orgId, onDone, onSkip }) {
  const [hostname, setHostname] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const json = await postJson('/api/admin/tenant-domains', 'POST', {
      hostname: hostname.trim().toLowerCase(),
      organization_id: orgId,
    })
    if (!json.success) {
      setError(json.error || 'Could not register the hostname.')
      setBusy(false)
      return
    }
    onDone()
  }

  return (
    <StepCard
      title="Subdomain"
      hint="Registers the hostname in the tenant domain registry — routing goes live immediately. DNS for the hostname (and its Vercel domain, if new) still needs to point at the platform."
    >
      <form onSubmit={submit}>
        <ErrorNote error={error} />
        <label className="block text-sm mb-4 max-w-sm">
          <span>Hostname</span>
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} required className={inputCls()} placeholder="fitco.un1tdublin.com" />
        </label>
        <div className="flex items-center gap-2">
          <PrimaryButton busy={busy}>Register hostname</PrimaryButton>
          <SkipButton onSkip={onSkip} />
        </div>
      </form>
    </StepCard>
  )
}

function DoneStep({ orgId }) {
  return (
    <StepCard title="Tenant created" hint="What usually comes next, in order:">
      <ul className="text-sm space-y-2 mb-4">
        <li>
          <Link href="/settings/integrations-hub" className="underline">Connect integrations</Link>
          <span className="text-un1t-subtle"> — Glofox, WhatsApp, Instagram, Xero, Meta ads.</span>
        </li>
        <li>
          <Link href="/admin/plans" className="underline">Assign a plan</Link>
          <span className="text-un1t-subtle"> — tiers, allowances and wallets live on the plans track.</span>
        </li>
        <li>
          <Link href="/settings/usage" className="underline">Set usage hard caps</Link>
          <span className="text-un1t-subtle"> — optional monthly brakes on AI spend and email volume.</span>
        </li>
        <li>
          <Link href="/admin/health" className="underline">Watch tenant health</Link>
          <span className="text-un1t-subtle"> — heartbeats, connections and spend, per location.</span>
        </li>
      </ul>
      <div className="flex items-center gap-3">
        <Link href="/admin/matrix" className="bg-un1t-text text-un1t-bg text-sm font-medium rounded-lg px-4 py-2">
          Open the admin matrix
        </Link>
        <Link href="/admin/tenants/new" className="text-sm text-un1t-subtle hover:text-un1t-text">
          Create another tenant
        </Link>
      </div>
      {orgId && <p className="text-xs text-un1t-subtle mt-3">Organisation id: {orgId}</p>}
    </StepCard>
  )
}
