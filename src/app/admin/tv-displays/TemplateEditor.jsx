'use client'

// TV-TEMPLATE.1 — template editor.
//
// A template is a fixed branded base image plus fixed text zones.
// The zone *layout* (position, size, style) is set here once; when
// staff later push the template they only retype the zone text.
//
// The editor canvas renders the base image at full width, so a
// zone's stored %-geometry maps 1:1 onto the canvas. Zones are
// dragged to move and corner-dragged to resize; the side panel
// edits the selected zone's text + styling.
//
// All writes go direct via the browser Supabase client — RLS on
// tv_templates is location-scoped (migration 190), same as the
// rest of /admin/tv-displays.

import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Plus, Trash2, Upload, AlertCircle, Image as ImageIcon, Type } from 'lucide-react'

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

export function bucketPublicUrl(path) {
  return `${SUPA_URL}/storage/v1/object/public/tv-content/${path}`
}

const FONT_WEIGHTS = [
  { value: 400, label: 'Regular' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extrabold' },
  { value: 900, label: 'Black' },
]

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

const INPUT_CLASS =
  'w-full bg-un1t-black border border-un1t-gray rounded px-2 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid'

function newZone() {
  return {
    id: 'z' + crypto.randomUUID().slice(0, 8),
    label: 'Text',
    x: 12, y: 40, width: 76, height: 18,
    fontSize: 8,
    fontWeight: 800,
    color: '#FFFFFF',
    align: 'center',
    vAlign: 'middle',
    uppercase: false,
    defaultText: '',
  }
}

export default function TemplateEditor({ template, locationId, currentUserId, db, onClose, onSaved }) {
  const isEdit = !!template
  const [name, setName] = useState(template?.name || '')
  const [baseImagePath, setBaseImagePath] = useState(template?.base_image_path || null)
  const [zones, setZones] = useState(
    Array.isArray(template?.zones) ? template.zones : []
  )
  const [selectedId, setSelectedId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const baseImageUrl = baseImagePath ? bucketPublicUrl(baseImagePath) : null
  const selected = zones.find(z => z.id === selectedId) || null

  function updateZone(id, patch) {
    setZones(zs => zs.map(z => (z.id === id ? { ...z, ...patch } : z)))
  }
  function deleteZone(id) {
    setZones(zs => zs.filter(z => z.id !== id))
    if (selectedId === id) setSelectedId(null)
  }
  function addZone() {
    const z = newZone()
    setZones(zs => [...zs, z])
    setSelectedId(z.id)
  }

  async function uploadBase(file) {
    setError(null)
    setBusy(true)
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
      const path = `${locationId}/templates/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await db.storage.from('tv-content').upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined,
      })
      if (upErr) throw new Error(upErr.message)
      setBaseImagePath(path)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setError(null)
    if (!name.trim()) { setError('Give the template a name.'); return }
    if (!baseImagePath) { setError('Upload a base image first.'); return }
    setBusy(true)
    try {
      if (isEdit) {
        const { error: e } = await db.from('tv_templates')
          .update({
            name: name.trim(),
            base_image_path: baseImagePath,
            zones,
            updated_at: new Date().toISOString(),
          })
          .eq('id', template.id)
        if (e) throw new Error(e.message)
      } else {
        const { error: e } = await db.from('tv_templates')
          .insert({
            location_id: locationId,
            name: name.trim(),
            base_image_path: baseImagePath,
            zones,
            created_by: currentUserId,
          })
        if (e) throw new Error(e.message)
      }
      await onSaved()
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg w-full max-w-5xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-un1t-gray">
          <div className="flex items-center gap-2">
            <Type size={16} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">{isEdit ? 'Edit template' : 'New template'}</h3>
          </div>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={16} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4">
          <div className="mb-4">
            <label className="block text-xs text-un1t-light mb-1">Template name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Welcome board"
              className="w-full max-w-sm bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
            />
          </div>

          {!baseImagePath ? (
            <BaseImageUploader busy={busy} onPick={uploadBase} />
          ) : (
            <div className="flex flex-col lg:flex-row gap-4">
              {/* Canvas */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-un1t-mid uppercase tracking-wide">
                    Drag zones to move · drag the corner to resize
                  </span>
                  <div className="flex items-center gap-2">
                    <ReplaceBaseButton busy={busy} onPick={uploadBase} />
                    <button
                      onClick={addZone}
                      className="inline-flex items-center gap-1 text-xs bg-un1t-white text-un1t-black font-medium px-2.5 py-1 rounded-md hover:bg-un1t-accent"
                    >
                      <Plus size={12} /> Add zone
                    </button>
                  </div>
                </div>
                <Canvas
                  baseImageUrl={baseImageUrl}
                  zones={zones}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onZoneChange={updateZone}
                />
              </div>

              {/* Properties panel */}
              <div className="lg:w-72 shrink-0">
                {selected ? (
                  <ZoneProperties
                    zone={selected}
                    onChange={patch => updateZone(selected.id, patch)}
                    onDelete={() => deleteZone(selected.id)}
                  />
                ) : (
                  <div className="bg-un1t-black border border-un1t-gray rounded-lg p-4 text-xs text-un1t-mid">
                    {zones.length === 0
                      ? 'No text zones yet. Click “Add zone” to drop one onto the image.'
                      : 'Select a zone on the image to edit its text and styling.'}
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 mt-3 flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-un1t-gray">
          <button onClick={onClose} className="text-sm text-un1t-light hover:text-un1t-white px-3 py-1.5 rounded-md">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="text-sm bg-un1t-white text-un1t-black font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
          >
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Base-image upload ───────────────────────────────────────────

function BaseImageUploader({ busy, onPick }) {
  return (
    <div className="bg-un1t-black border border-dashed border-un1t-gray rounded-lg p-10 text-center">
      <ImageIcon size={28} className="text-un1t-mid mx-auto mb-3" />
      <p className="text-sm text-un1t-light mb-1">Upload the branded base image</p>
      <p className="text-xs text-un1t-mid mb-4">
        This stays fixed for the template — staff only change the text on top of it. Landscape, ideally 1920×1080.
      </p>
      <label className="inline-flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-medium px-3 py-1.5 rounded-md hover:bg-un1t-accent cursor-pointer">
        <Upload size={14} /> {busy ? 'Uploading…' : 'Choose image'}
        <input
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f) }}
          className="hidden"
        />
      </label>
    </div>
  )
}

function ReplaceBaseButton({ busy, onPick }) {
  return (
    <label className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white border border-un1t-gray hover:border-un1t-white/30 px-2.5 py-1 rounded-md cursor-pointer">
      <Upload size={12} /> {busy ? 'Uploading…' : 'Replace image'}
      <input
        type="file"
        accept="image/*"
        disabled={busy}
        onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f) }}
        className="hidden"
      />
    </label>
  )
}

// ── Canvas + draggable zones ────────────────────────────────────

function Canvas({ baseImageUrl, zones, selectedId, onSelect, onZoneChange }) {
  const canvasRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={canvasRef}
      onPointerDown={() => onSelect(null)}
      style={{ position: 'relative', width: '100%', userSelect: 'none', background: '#000' }}
      className="border border-un1t-gray rounded-md overflow-hidden"
    >
      <img
        src={baseImageUrl}
        alt=""
        draggable={false}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
      {zones.map(z => (
        <ZoneBox
          key={z.id}
          zone={z}
          canvasSize={size}
          selected={z.id === selectedId}
          onSelect={onSelect}
          onChange={patch => onZoneChange(z.id, patch)}
        />
      ))}
    </div>
  )
}

function ZoneBox({ zone, canvasSize, selected, onSelect, onChange }) {
  const boxRef = useRef(null)
  const dragRef = useRef(null)

  const begin = useCallback((e, mode) => {
    e.stopPropagation()
    onSelect(zone.id)
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      w: canvasSize.w || 1,
      h: canvasSize.h || 1,
      orig: { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
    }
    boxRef.current?.setPointerCapture(e.pointerId)
  }, [zone, canvasSize, onSelect])

  function move(e) {
    const d = dragRef.current
    if (!d) return
    const dx = ((e.clientX - d.startX) / d.w) * 100
    const dy = ((e.clientY - d.startY) / d.h) * 100
    if (d.mode === 'move') {
      onChange({
        x: clamp(d.orig.x + dx, 0, 100 - d.orig.width),
        y: clamp(d.orig.y + dy, 0, 100 - d.orig.height),
      })
    } else {
      onChange({
        width: clamp(d.orig.width + dx, 5, 100 - d.orig.x),
        height: clamp(d.orig.height + dy, 4, 100 - d.orig.y),
      })
    }
  }
  function end(e) {
    dragRef.current = null
    boxRef.current?.releasePointerCapture?.(e.pointerId)
  }

  const fontPx = ((zone.fontSize || 6) / 100) * (canvasSize.h || 0)
  const text = zone.defaultText || zone.label || ''

  return (
    <div
      ref={boxRef}
      onPointerDown={e => begin(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      style={{
        position: 'absolute',
        left: `${zone.x}%`,
        top: `${zone.y}%`,
        width: `${zone.width}%`,
        height: `${zone.height}%`,
        boxSizing: 'border-box',
        border: selected ? '2px solid #4ade80' : '1px dashed rgba(255,255,255,0.6)',
        background: selected ? 'rgba(74,222,128,0.08)' : 'rgba(0,0,0,0.04)',
        cursor: 'move',
        touchAction: 'none',
        display: 'flex',
        alignItems: { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[zone.vAlign] || 'center',
        justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[zone.align] || 'center',
        overflow: 'hidden',
      }}
    >
      {/* zone label chip */}
      <span
        style={{
          position: 'absolute', top: 0, left: 0,
          background: selected ? '#4ade80' : 'rgba(0,0,0,0.7)',
          color: selected ? '#000' : '#fff',
          fontSize: 9, lineHeight: '12px', padding: '1px 4px',
          fontWeight: 600, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden',
        }}
      >
        {zone.label}
      </span>
      {/* preview text */}
      <span
        style={{
          width: '100%',
          textAlign: zone.align || 'center',
          color: zone.color || '#fff',
          fontWeight: zone.fontWeight || 700,
          fontSize: fontPx ? `${fontPx}px` : '14px',
          lineHeight: 1.12,
          textTransform: zone.uppercase ? 'uppercase' : 'none',
          opacity: zone.defaultText ? 1 : 0.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          pointerEvents: 'none',
        }}
      >
        {text}
      </span>
      {/* resize handle */}
      <div
        onPointerDown={e => begin(e, 'resize')}
        onPointerMove={move}
        onPointerUp={end}
        style={{
          position: 'absolute', right: -1, bottom: -1,
          width: 14, height: 14,
          background: selected ? '#4ade80' : 'rgba(255,255,255,0.7)',
          cursor: 'nwse-resize', touchAction: 'none',
        }}
      />
    </div>
  )
}

// ── Zone property panel ─────────────────────────────────────────

function ZoneProperties({ zone, onChange, onDelete }) {
  return (
    <div className="bg-un1t-black border border-un1t-gray rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-un1t-light uppercase tracking-wide">Zone</span>
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>

      <Field label="Label (shown to staff)">
        <input
          value={zone.label}
          onChange={e => onChange({ label: e.target.value })}
          className={INPUT_CLASS}
        />
      </Field>

      <Field label="Default text (optional)">
        <textarea
          value={zone.defaultText}
          onChange={e => onChange({ defaultText: e.target.value })}
          rows={2}
          placeholder="Pre-fills when staff push this template"
          className={`${INPUT_CLASS} resize-none`}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Font size (% of height)">
          <input
            type="number" min={2} max={40} step={0.5}
            value={zone.fontSize}
            onChange={e => onChange({ fontSize: clamp(Number(e.target.value) || 6, 2, 40) })}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Weight">
          <select
            value={zone.fontWeight}
            onChange={e => onChange({ fontWeight: Number(e.target.value) })}
            className={INPUT_CLASS}
          >
            {FONT_WEIGHTS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Horizontal">
          <select
            value={zone.align}
            onChange={e => onChange({ align: e.target.value })}
            className={INPUT_CLASS}
          >
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </Field>
        <Field label="Vertical">
          <select
            value={zone.vAlign}
            onChange={e => onChange({ vAlign: e.target.value })}
            className={INPUT_CLASS}
          >
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Field label="Colour">
          <input
            type="color"
            value={zone.color}
            onChange={e => onChange({ color: e.target.value })}
            className="w-full h-8 bg-un1t-black border border-un1t-gray rounded cursor-pointer"
          />
        </Field>
        <label className="flex items-center gap-1.5 text-xs text-un1t-light pt-4 whitespace-nowrap">
          <input
            type="checkbox"
            checked={!!zone.uppercase}
            onChange={e => onChange({ uppercase: e.target.checked })}
          />
          UPPERCASE
        </label>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-un1t-mid mb-1">{label}</span>
      {children}
    </label>
  )
}
