'use client'

// TV.1 — TV admin UI.
//
// Each TV row shows:
//   - Label, URL (with copy button — paste into UC Cast Pro's
//     Web URL setting once when registering the cast)
//   - What's currently displayed
//   - Buttons: Push image (upload OR URL), Clear (back to idle),
//     Delete (remove the TV from the location)
//
// All mutations go direct via the browser Supabase client — RLS
// already allows authenticated-in-location operators full CRUD
// on tv_displays + tv_content. The /tv/[token] page reads via
// service-role through /api/tv/[token]/content; this page never
// needs to touch that public path.

import { useState, useCallback } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { Tv, Plus, Copy, Check, Trash2, Upload, Link2, X, Image as ImageIcon, AlertCircle, RotateCcw, RotateCw } from 'lucide-react'

// TV-ROTATION.1 — screen-rotation options offered per display.
// Value is clockwise degrees, matched 1:1 by the CSS rotate() the
// /tv/cast page applies (see TVDisplay.jsx + migration 189).
const ORIENTATION_OPTIONS = [
  { value: 0,   label: 'Landscape' },
  { value: 90,  label: 'Portrait — rotated right' },
  { value: 270, label: 'Portrait — rotated left' },
  { value: 180, label: 'Landscape — upside down' },
]

export default function TVAdmin({ initialDisplays, locationId, currentUserId }) {
  const db = createBrowserClient()
  const [displays, setDisplays] = useState(initialDisplays)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    const { data } = await db.from('tv_displays')
      .select('*, tv_content(*)')
      .eq('location_id', locationId)
      .order('created_at', { ascending: true })
    setDisplays(data || [])
  }, [db, locationId])

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-2xl font-bold">TV Displays</h2>
        <button
          onClick={() => setRegisterOpen(true)}
          className="inline-flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-medium px-3 py-1.5 rounded-md hover:bg-un1t-accent"
        >
          <Plus size={14} /> Register TV
        </button>
      </div>
      <p className="text-sm text-un1t-light mb-5">
        Each TV gets a unique URL. Paste it into UC Cast Pro&apos;s &ldquo;Web URL&rdquo; content source — the cast will render whatever the CRM serves at that URL.
      </p>

      {error && (
        <div className="mb-4 flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      <div className="space-y-4">
        {displays.length === 0 && !registerOpen && (
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
            <Tv size={32} className="text-un1t-mid mx-auto mb-3" />
            <p className="text-sm text-un1t-light mb-1">No TVs registered yet.</p>
            <p className="text-xs text-un1t-mid">Click &ldquo;Register TV&rdquo; to add one and get a URL for UC Cast Pro.</p>
          </div>
        )}

        {displays.map(d => (
          <TVCard
            key={d.id}
            display={d}
            currentUserId={currentUserId}
            onError={setError}
            onChange={refresh}
            db={db}
          />
        ))}
      </div>

      {registerOpen && (
        <RegisterTVModal
          onClose={() => setRegisterOpen(false)}
          onCreate={async (label) => {
            setError(null)
            const { error: e } = await db.from('tv_displays')
              .insert({ location_id: locationId, label })
            if (e) { setError(e.message); return }
            await refresh()
            setRegisterOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ── Per-TV row ──────────────────────────────────────────────────

function TVCard({ display, currentUserId, onError, onChange, db }) {
  const content = Array.isArray(display.tv_content) ? display.tv_content[0] : display.tv_content
  const tvUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/tv/cast/${display.token}`
    : `/tv/cast/${display.token}`

  const [copied, setCopied] = useState(false)
  const [pushOpen, setPushOpen] = useState(false)

  async function clearContent() {
    if (!confirm(`Clear ${display.label}? The TV will fall back to the idle screen.`)) return
    onError(null)
    const { error } = await db.from('tv_content')
      .delete()
      .eq('tv_display_id', display.id)
    if (error) onError(error.message)
    await onChange()
  }

  async function deleteTV() {
    if (!confirm(`Delete ${display.label}? The TV URL will stop working — you'll need to update UC Cast Pro if it's currently using this URL.`)) return
    onError(null)
    const { error } = await db.from('tv_displays')
      .delete()
      .eq('id', display.id)
    if (error) onError(error.message)
    await onChange()
  }

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
      <div className="p-4 flex flex-wrap items-start gap-3 border-b border-un1t-gray">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2">
            <Tv size={16} className="text-un1t-light" />
            <span className="text-sm font-medium text-un1t-white">{display.label}</span>
            {!display.active && <span className="text-[10px] text-un1t-mid uppercase">Inactive</span>}
          </div>
          <div className="mt-2 flex items-center gap-2 max-w-full">
            <code className="text-[11px] text-un1t-light bg-un1t-black border border-un1t-gray rounded px-2 py-1 flex-1 truncate">
              {tvUrl}
            </code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(tvUrl)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white px-2 py-1 rounded border border-un1t-gray"
              title="Copy URL"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPushOpen(true)}
            className="inline-flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-medium px-3 py-1.5 rounded-md hover:bg-un1t-accent"
          >
            <ImageIcon size={14} /> Push image
          </button>
          {content && (
            <button
              onClick={clearContent}
              className="inline-flex items-center gap-1 text-sm text-un1t-light hover:text-un1t-white border border-un1t-gray hover:border-un1t-white/30 px-3 py-1.5 rounded-md"
              title="Revert to idle screen"
            >
              <RotateCcw size={14} /> Clear
            </button>
          )}
          <button
            onClick={deleteTV}
            className="inline-flex items-center text-sm text-red-400 hover:text-red-300 border border-un1t-gray hover:border-red-400/40 px-2 py-1.5 rounded-md"
            title="Delete TV"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="px-4 py-3 text-xs text-un1t-light flex items-center gap-3 flex-wrap">
        <span className="text-un1t-mid uppercase tracking-wide">Now showing</span>
        {content ? (
          <>
            <span className="text-un1t-white">{content.label || content.source_ref}</span>
            <span className="text-un1t-mid">·</span>
            <span className="text-un1t-mid">{content.source_type}</span>
            <span className="text-un1t-mid">·</span>
            <span className="text-un1t-mid">pushed {new Date(content.pushed_at).toLocaleString('en-IE', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
          </>
        ) : (
          <span className="text-un1t-mid">Idle — UN1T mark + clock</span>
        )}
        <OrientationControl display={display} db={db} onError={onError} onChange={onChange} />
      </div>

      {pushOpen && (
        <PushModal
          onClose={() => setPushOpen(false)}
          onPush={async ({ source_type, source_ref, label }) => {
            onError(null)
            const { error } = await db.from('tv_content').upsert({
              tv_display_id: display.id,
              source_type,
              source_ref,
              label,
              pushed_at: new Date().toISOString(),
              pushed_by: currentUserId,
              triggered_by: `manual:${currentUserId}`,
            }, { onConflict: 'tv_display_id' })
            if (error) { onError(error.message); return }
            await onChange()
            setPushOpen(false)
          }}
          locationId={display.location_id}
          db={db}
        />
      )}
    </div>
  )
}

// ── Orientation control ─────────────────────────────────────────
//
// TV-ROTATION.1 — picks how the panel is physically hung. Writes
// tv_displays.rotation; the /tv/cast page picks the change up on
// its next 3s poll, so the operator can re-aim a TV live without
// touching the cast device.

function OrientationControl({ display, db, onError, onChange }) {
  const [saving, setSaving] = useState(false)
  const rotation = display.rotation ?? 0

  async function setRotation(value) {
    if (value === rotation) return
    onError(null)
    setSaving(true)
    const { error } = await db.from('tv_displays')
      .update({ rotation: value })
      .eq('id', display.id)
    setSaving(false)
    if (error) { onError(error.message); return }
    await onChange()
  }

  return (
    <label className="ml-auto inline-flex items-center gap-1.5 text-un1t-mid">
      {rotation === 0 ? <RotateCw size={12} /> : <RotateCw size={12} className="text-un1t-light" />}
      <span className="uppercase tracking-wide">Orientation</span>
      <select
        value={rotation}
        disabled={saving}
        onChange={e => setRotation(Number(e.target.value))}
        className="bg-un1t-black border border-un1t-gray rounded px-2 py-1 text-un1t-white focus:outline-none focus:border-un1t-mid disabled:opacity-50"
      >
        {ORIENTATION_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

// ── Register modal ──────────────────────────────────────────────

function RegisterTVModal({ onClose, onCreate }) {
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!label.trim()) return
    setSaving(true)
    try { await onCreate(label.trim()) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Register TV</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={16} /></button>
        </div>
        <label className="block text-xs text-un1t-light mb-1">Label</label>
        <input
          autoFocus
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Lobby TV"
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
        />
        <p className="text-xs text-un1t-mid mt-2">
          A unique URL gets generated. Paste it into UC Cast Pro&apos;s Web URL content source on the device.
        </p>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="text-sm text-un1t-light hover:text-un1t-white px-3 py-1.5 rounded-md">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !label.trim()}
            className="text-sm bg-un1t-white text-un1t-black font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Push modal — upload or URL ──────────────────────────────────

function PushModal({ onClose, onPush, locationId, db }) {
  const [mode, setMode] = useState('upload')   // 'upload' | 'url'
  const [file, setFile] = useState(null)
  const [externalUrl, setExternalUrl] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      if (mode === 'upload') {
        if (!file) { setError('Pick an image to upload.'); setBusy(false); return }
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
        const path = `${locationId}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await db.storage.from('tv-content').upload(path, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || undefined,
        })
        if (upErr) throw new Error(upErr.message)
        await onPush({
          source_type: 'storage',
          source_ref: path,
          label: label.trim() || file.name,
        })
      } else {
        if (!externalUrl.trim()) { setError('Paste a URL.'); setBusy(false); return }
        await onPush({
          source_type: 'url',
          source_ref: externalUrl.trim(),
          label: label.trim() || null,
        })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Push to TV</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={16} /></button>
        </div>

        <div className="inline-flex border border-un1t-gray rounded-md overflow-hidden mb-3">
          {[
            { key: 'upload', Icon: Upload, label: 'Upload' },
            { key: 'url',    Icon: Link2,  label: 'URL' },
          ].map(({ key, Icon, label }) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 ${mode === key ? 'bg-un1t-gray text-un1t-white' : 'text-un1t-light hover:bg-un1t-gray/30'}`}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>

        {mode === 'upload' && (
          <div className="mb-3">
            <input
              type="file"
              accept="image/*"
              onChange={e => setFile(e.target.files?.[0] || null)}
              className="block w-full text-xs text-un1t-light file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-un1t-gray file:text-un1t-white hover:file:bg-un1t-mid"
            />
            {file && (
              <p className="text-[11px] text-un1t-mid mt-1.5">{file.name} · {Math.round(file.size / 1024)} KB</p>
            )}
          </div>
        )}

        {mode === 'url' && (
          <div className="mb-3">
            <input
              type="url"
              value={externalUrl}
              onChange={e => setExternalUrl(e.target.value)}
              placeholder="https://…image.jpg"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
            />
            <p className="text-[11px] text-un1t-mid mt-1.5">
              The cast loads this URL directly. Make sure it&apos;s publicly accessible.
            </p>
          </div>
        )}

        <label className="block text-xs text-un1t-light mb-1">Label (optional)</label>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Welcome Sarah"
          className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid mb-3"
        />

        {error && (
          <p className="text-xs text-red-400 mb-2 flex items-center gap-1">
            <AlertCircle size={12} /> {error}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="text-sm text-un1t-light hover:text-un1t-white px-3 py-1.5 rounded-md">Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className="text-sm bg-un1t-white text-un1t-black font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
          >
            {busy ? 'Pushing…' : 'Push to TV'}
          </button>
        </div>
      </div>
    </div>
  )
}
