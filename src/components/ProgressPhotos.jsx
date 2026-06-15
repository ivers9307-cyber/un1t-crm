'use client'
// ProgressPhotos.jsx — CONSULTATIONS SP1
//
// Chronological (newest-first) thumbnail gallery of a contact's progress
// photos, plus an upload control. Photos live in the private
// 'consultation-photos' Supabase Storage bucket; the page generates a
// short-lived signed `url` per photo before passing them in.
//
// Props:
//   contactId — string UUID of the contact
//   photos    — Array<{ id, url (pre-signed), taken_at, label, caption }>
//
// Upload POSTs multipart (field `file` + optional label/caption) to the
// photos API; delete hits the per-photo route. router.refresh() after
// either. Every non-submit button is type="button".

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ImagePlus, Trash2, AlertCircle } from 'lucide-react'
import { Card, Button, Field } from '@/components/ui'

function formatPhotoDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function ProgressPhotos({ contactId, photos = [] }) {
  const router = useRouter()
  const fileInputRef = useRef(null)

  const [file, setFile] = useState(null)
  const [label, setLabel] = useState('')
  const [caption, setCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  // Newest-first (defensive — the page already orders by taken_at desc).
  const ordered = [...photos].sort((a, b) => String(b.taken_at || '').localeCompare(String(a.taken_at || '')))

  function resetForm() {
    setFile(null); setLabel(''); setCaption('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function upload(e) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (label.trim()) fd.append('label', label.trim())
      if (caption.trim()) fd.append('caption', caption.trim())
      // NOTE: no JSON Content-Type — let the browser set the multipart
      // boundary itself.
      const r = await fetch(`/api/contacts/${contactId}/consultation-photos`, {
        method: 'POST',
        body: fd,
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Upload failed (${r.status})`)
        return
      }
      resetForm()
      router.refresh()
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setUploading(false)
    }
  }

  async function deletePhoto(pid) {
    if (!window.confirm('Delete this photo?')) return
    setBusyId(pid)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/consultation-photos/${pid}`, { method: 'DELETE' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        return
      }
      router.refresh()
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card title="Progress photos">
      {error && (
        <p className="text-xs text-red-700 mb-3 flex items-center gap-1">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {/* Upload control */}
      <form onSubmit={upload} className="mb-4 space-y-2 rounded-md border border-un1t-border bg-un1t-bg/50 p-3">
        <Field id="photo-file" label="Photo">
          {(p) => (
            <input
              {...p}
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-un1t-subtle file:mr-3 file:rounded-md file:border-0 file:bg-un1t-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-un1t-text"
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id="photo-label" label="Label">
            {(p) => (
              <input
                {...p}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Front"
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
              />
            )}
          </Field>
          <Field id="photo-caption" label="Caption">
            {(p) => (
              <input
                {...p}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Optional note"
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
              />
            )}
          </Field>
        </div>
        <Button type="submit" size="sm" icon={ImagePlus} loading={uploading} disabled={!file}>Upload photo</Button>
      </form>

      {/* Gallery */}
      {ordered.length === 0 ? (
        <p className="text-sm text-un1t-subtle">No progress photos yet.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {ordered.map((photo) => (
            <figure key={photo.id} className="group relative rounded-lg overflow-hidden border border-un1t-border bg-un1t-bg">
              {/* Plain <img>: the src is a short-lived signed Storage URL,
                  not a next/image-whitelisted host. */}
              <img
                src={photo.url}
                alt={photo.label || photo.caption || 'Progress photo'}
                className="w-full h-40 object-cover"
              />
              <button
                type="button"
                aria-label="Delete photo"
                disabled={busyId === photo.id}
                onClick={() => deletePhoto(photo.id)}
                className="absolute top-1.5 right-1.5 rounded-md bg-black/50 p-1.5 text-white opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
              <figcaption className="px-2 py-1.5">
                <p className="text-[11px] text-un1t-muted">{formatPhotoDate(photo.taken_at)}</p>
                {photo.label && <p className="text-xs font-medium text-un1t-text truncate">{photo.label}</p>}
                {photo.caption && <p className="text-[11px] text-un1t-subtle truncate">{photo.caption}</p>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Card>
  )
}
