'use client'

import { useState, useEffect, useRef } from 'react'
// `Image` is renamed to ImageIcon so eslint-plugin-jsx-a11y doesn't
// confuse it with an HTML <img> element and demand an alt prop.
import { Image as ImageIcon, Upload, Trash2, Check } from 'lucide-react'

// `locationId` is optional and falls back to the user's active location,
// but the only mounter today is /settings/locations/[id], which passes the
// explicit id of the location being edited so a master can upload, e.g.
// CCF Autos branding while their active location is UN1T Stillorgan. The
// routes gate on master-or-owner AT THAT location; a refusal surfaces as an
// alert rather than a button that quietly returns to "Save".
export default function BrandingSettings({ user, locationId: propLocationId }) {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(null) // 'logo' | 'favicon' | null
  const [companyName, setCompanyName] = useState('')
  const [saved, setSaved] = useState(false)
  const logoInputRef = useRef(null)
  const faviconInputRef = useRef(null)

  const locationId = propLocationId || user.activeLocation?.id

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/settings/branding?location_id=${locationId}`)
      const data = await res.json()
      if (data.success && data.data) {
        setSettings(data.data)
        setCompanyName(data.data.company_name || '')
      }
      setLoading(false)
    }
    load()
  }, [locationId])

  async function handleUpload(file, type) {
    if (!file) return
    setUploading(type)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('type', type)
    formData.append('location_id', locationId)

    const res = await fetch('/api/settings/branding/upload', {
      method: 'POST',
      body: formData,
    })
    const data = await res.json()

    if (data.success) {
      // Update the settings record with the new URL
      const updateBody = {
        location_id: locationId,
        company_name: companyName || null,
        logo_url: type === 'logo' ? data.url : (settings?.logo_url || null),
        favicon_url: type === 'favicon' ? data.url : (settings?.favicon_url || null),
      }

      const saveRes = await fetch('/api/settings/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      })
      const saveData = await saveRes.json()
      if (saveData.success) {
        setSettings(saveData.data)
        // Only update the live browser favicon when editing the
        // ACTIVE location — otherwise editing CCF Autos branding
        // from a UN1T-active session would clobber the UN1T tab
        // icon until reload.
        if (type === 'favicon' && locationId === user.activeLocation?.id) {
          updateBrowserFavicon(data.url)
        }
      }
    } else {
      alert(data.error || 'Upload failed')
    }
    setUploading(null)
  }

  async function handleRemove(type) {
    const updateBody = {
      location_id: locationId,
      company_name: companyName || null,
      logo_url: type === 'logo' ? null : (settings?.logo_url || null),
      favicon_url: type === 'favicon' ? null : (settings?.favicon_url || null),
    }

    setSaving(true)
    const res = await fetch('/api/settings/branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody),
    })
    const data = await res.json()
    if (data.success) {
      setSettings(data.data)
      if (type === 'favicon' && locationId === user.activeLocation?.id) {
        updateBrowserFavicon(null)
      }
    } else {
      alert(data.error || 'Remove failed')
    }
    setSaving(false)
  }

  async function handleSaveName() {
    setSaving(true)
    const res = await fetch('/api/settings/branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        company_name: companyName || null,
        logo_url: settings?.logo_url || null,
        favicon_url: settings?.favicon_url || null,
      }),
    })
    const data = await res.json()
    if (data.success) {
      setSettings(data.data)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } else {
      alert(data.error || 'Save failed')
    }
    setSaving(false)
  }

  function updateBrowserFavicon(url) {
    let link = document.querySelector("link[rel~='icon']")
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = url || '/favicon.ico'
  }

  if (loading) {
    return <div className="text-sm text-un1t-subtle py-4">Loading branding...</div>
  }

  return (
    <div className="space-y-6">
      {/* Company Name */}
      <div>
        <label className="block text-xs font-medium text-un1t-subtle mb-1.5">Company Name</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={companyName}
            onChange={e => setCompanyName(e.target.value)}
            className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            placeholder="UN1T"
          />
          <button
            onClick={handleSaveName}
            disabled={saving}
            className="px-4 py-2 bg-un1t-text text-un1t-bg text-xs font-medium rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {saved ? <><Check size={12} /> Saved</> : saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Logo Upload */}
      <div>
        <label className="block text-xs font-medium text-un1t-subtle mb-1.5">Logo</label>
        <p className="text-xs text-un1t-muted mb-3">Transparent PNG or SVG recommended. Displayed in the sidebar and login page.</p>

        <div className="flex items-start gap-4">
          {/* Preview */}
          <div className="w-32 h-16 bg-un1t-bg border border-un1t-border rounded-lg flex items-center justify-center overflow-hidden shrink-0"
               style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' fill=\'none\'%3E%3Crect x=\'0\' y=\'0\' width=\'8\' height=\'8\' fill=\'%23222\'/%3E%3Crect x=\'8\' y=\'8\' width=\'8\' height=\'8\' fill=\'%23222\'/%3E%3C/svg%3E")' }}>
            {settings?.logo_url ? (
              <img src={settings.logo_url} alt="Logo" className="max-w-full max-h-full object-contain" />
            ) : (
              <ImageIcon size={20} className="text-un1t-muted" />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/svg+xml,image/webp"
              className="hidden"
              onChange={e => handleUpload(e.target.files[0], 'logo')}
            />
            <button
              onClick={() => logoInputRef.current?.click()}
              disabled={uploading === 'logo'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-un1t-surface border border-un1t-border rounded-md text-un1t-text hover:bg-un1t-border/50 transition-colors disabled:opacity-50"
            >
              <Upload size={12} />
              {uploading === 'logo' ? 'Uploading...' : 'Upload Logo'}
            </button>
            {settings?.logo_url && (
              <button
                onClick={() => handleRemove('logo')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                <Trash2 size={12} />
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Favicon Upload */}
      <div>
        <label className="block text-xs font-medium text-un1t-subtle mb-1.5">Favicon</label>
        <p className="text-xs text-un1t-muted mb-3">Small icon shown in browser tabs. PNG or ICO, ideally 32x32 or 64x64.</p>

        <div className="flex items-start gap-4">
          {/* Preview */}
          <div className="w-16 h-16 bg-un1t-bg border border-un1t-border rounded-lg flex items-center justify-center overflow-hidden shrink-0"
               style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\' fill=\'none\'%3E%3Crect x=\'0\' y=\'0\' width=\'8\' height=\'8\' fill=\'%23222\'/%3E%3Crect x=\'8\' y=\'8\' width=\'8\' height=\'8\' fill=\'%23222\'/%3E%3C/svg%3E")' }}>
            {settings?.favicon_url ? (
              <img src={settings.favicon_url} alt="Favicon" className="w-8 h-8 object-contain" />
            ) : (
              <ImageIcon size={16} className="text-un1t-muted" />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <input
              ref={faviconInputRef}
              type="file"
              accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/webp"
              className="hidden"
              onChange={e => handleUpload(e.target.files[0], 'favicon')}
            />
            <button
              onClick={() => faviconInputRef.current?.click()}
              disabled={uploading === 'favicon'}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-un1t-surface border border-un1t-border rounded-md text-un1t-text hover:bg-un1t-border/50 transition-colors disabled:opacity-50"
            >
              <Upload size={12} />
              {uploading === 'favicon' ? 'Uploading...' : 'Upload Favicon'}
            </button>
            {settings?.favicon_url && (
              <button
                onClick={() => handleRemove('favicon')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                <Trash2 size={12} />
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
