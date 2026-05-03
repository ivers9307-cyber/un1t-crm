'use client'

// AddOrganizationButton — small button + modal at the top of
// /admin/matrix. Master-only (page is already gated). On success,
// refreshes the matrix so the new org appears in both sections
// immediately.
//
// Slug is auto-suggested from name as the user types, but editable
// — operators may want a shorter or different slug. Validation
// matches what the API enforces (lowercase kebab-case).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Plus, X, AlertCircle, Loader2 } from 'lucide-react'
import { toSlug } from '@/lib/slug'

export default function AddOrganizationButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  // True until the user manually edits slug — then we stop tracking
  // name changes so we don't clobber their custom slug.
  const [slugAuto, setSlugAuto] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  function reset() {
    setName(''); setSlug(''); setSlugAuto(true); setError(null); setBusy(false)
  }
  function close() {
    if (busy) return
    setOpen(false)
    reset()
  }

  function onNameChange(v) {
    setName(v)
    if (slugAuto) setSlug(toSlug(v))
  }
  function onSlugChange(v) {
    setSlug(v)
    setSlugAuto(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/admin/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim() || undefined }),
      })
      const body = await r.json()
      if (!r.ok || body.success === false) {
        throw new Error(body.error || `Create failed (${r.status})`)
      }
      // Close + refresh the server-rendered matrix so the new org shows up.
      setOpen(false)
      reset()
      router.refresh()
    } catch (err) {
      setError(err.message || 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
      >
        <Plus size={12} /> Add organization
      </button>

      {open && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={close} aria-hidden="true" />
          <form
            onSubmit={handleCreate}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-un1t-black border border-un1t-gray rounded-lg p-6 w-[440px] max-w-[90vw] shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <h3 className="text-base font-semibold text-un1t-white inline-flex items-center gap-2">
                <Building2 size={16} /> Add organization
              </h3>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="text-un1t-light hover:text-un1t-white disabled:opacity-40"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-xs text-un1t-light mb-4">
              Tenant grouping above locations. After creating, head to Settings → Locations →
              Add Location to create the first location under this org. Members are added via
              the access matrix.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-un1t-light mb-1">Name <span className="text-red-700">*</span></label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => onNameChange(e.target.value)}
                  disabled={busy}
                  placeholder="UN1T Group"
                  className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
                />
              </div>
              <div>
                <label className="block text-xs text-un1t-light mb-1">
                  Slug
                  {slugAuto && <span className="ml-1 text-[10px] text-un1t-mid">(auto-derived)</span>}
                </label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => onSlugChange(e.target.value.toLowerCase())}
                  disabled={busy}
                  placeholder="un1t-group"
                  pattern="^[a-z0-9]+(-[a-z0-9]+)*$"
                  className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
                />
                <p className="text-[11px] text-un1t-mid mt-1">
                  Lowercase letters, digits, hyphens. Reserved for future per-org sub-paths.
                </p>
              </div>
            </div>

            {error && (
              <div className="mt-4 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2 inline-flex items-start gap-2">
                <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="text-sm text-un1t-light hover:text-un1t-white disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim() || !slug.trim()}
                className="inline-flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-semibold px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-40"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {busy ? 'Creating…' : 'Create organization'}
              </button>
            </div>
          </form>
        </>
      )}
    </>
  )
}
