'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Send, Plus, Trash2 } from 'lucide-react'

const CATEGORIES = [
  { value: 'MARKETING', label: 'Marketing', description: 'Promotions, offers, updates' },
  { value: 'UTILITY', label: 'Utility', description: 'Order updates, booking confirmations' },
  { value: 'AUTHENTICATION', label: 'Authentication', description: 'OTP and verification codes' },
]

const HEADER_FORMATS = [
  { value: 'NONE', label: 'No header' },
  { value: 'TEXT', label: 'Text' },
  { value: 'IMAGE', label: 'Image' },
  { value: 'VIDEO', label: 'Video' },
  { value: 'DOCUMENT', label: 'Document' },
]

export default function WATemplateEditor({ template, locationId, userId }) {
  const router = useRouter()
  const isEditing = !!template
  const isSubmitted = template?.status && template.status !== 'draft'

  const [name, setName] = useState(template?.name || '')
  const [category, setCategory] = useState(template?.category || 'MARKETING')
  const [language, setLanguage] = useState(template?.language || 'en')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Component state
  const existingComponents = template?.components || []
  const existingHeader = existingComponents.find(c => c.type === 'HEADER')
  const existingBody = existingComponents.find(c => c.type === 'BODY')
  const existingFooter = existingComponents.find(c => c.type === 'FOOTER')
  const existingButtons = existingComponents.find(c => c.type === 'BUTTONS')

  const [headerFormat, setHeaderFormat] = useState(existingHeader?.format || 'NONE')
  const [headerText, setHeaderText] = useState(existingHeader?.text || '')
  const [bodyText, setBodyText] = useState(existingBody?.text || '')
  const [footerText, setFooterText] = useState(existingFooter?.text || '')
  const [buttons, setButtons] = useState(existingButtons?.buttons || [])

  function buildComponents() {
    const components = []

    if (headerFormat !== 'NONE') {
      const header = { type: 'HEADER', format: headerFormat }
      if (headerFormat === 'TEXT') header.text = headerText
      else header.example = { header_handle: ['https://example.com/placeholder'] }
      components.push(header)
    }

    if (bodyText) {
      const bodyComp = { type: 'BODY', text: bodyText }
      // Extract example values for variables
      const vars = bodyText.match(/\{\{\d+\}\}/g) || []
      if (vars.length > 0) {
        bodyComp.example = {
          body_text: [vars.map((_, i) => `Example ${i + 1}`)]
        }
      }
      components.push(bodyComp)
    }

    if (footerText) {
      components.push({ type: 'FOOTER', text: footerText })
    }

    if (buttons.length > 0) {
      components.push({ type: 'BUTTONS', buttons })
    }

    return components
  }

  async function handleSave() {
    if (!name || !bodyText) {
      setError('Template name and body text are required')
      return
    }

    // Meta requires lowercase with underscores only
    const cleanName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_')

    setSaving(true)
    setError(null)

    try {
      const payload = {
        name: cleanName,
        category,
        language,
        components: buildComponents(),
        location_id: locationId,
        created_by: userId,
      }

      const url = isEditing ? `/api/whatsapp/templates/${template.id}` : '/api/whatsapp/templates'
      const method = isEditing ? 'PUT' : 'POST'

      const result = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.json())

      if (!result.success) throw new Error(result.error)

      router.push('/whatsapp/templates')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function addButton(type) {
    if (buttons.length >= 3) return
    const newButton = type === 'URL'
      ? { type: 'URL', text: '', url: '' }
      : type === 'PHONE_NUMBER'
      ? { type: 'PHONE_NUMBER', text: '', phone_number: '' }
      : { type: 'QUICK_REPLY', text: '' }
    setButtons([...buttons, newButton])
  }

  function updateButton(index, updates) {
    setButtons(buttons.map((b, i) => i === index ? { ...b, ...updates } : b))
  }

  function removeButton(index) {
    setButtons(buttons.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-gray bg-un1t-dark shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/whatsapp/templates" className="text-un1t-light hover:text-un1t-white transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <h2 className="text-lg font-semibold">
            {isEditing ? 'Edit Template' : 'New Template'}
          </h2>
          {template?.status && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              template.status === 'APPROVED' ? 'bg-green-500/20 text-green-400' :
              template.status === 'REJECTED' ? 'bg-red-500/20 text-red-400' :
              template.status === 'PENDING' ? 'bg-yellow-500/20 text-yellow-400' :
              'bg-gray-500/20 text-gray-400'
            }`}>
              {template.status}
            </span>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving || isSubmitted}
          className="flex items-center gap-1.5 text-sm bg-un1t-white text-un1t-black font-medium px-4 py-1.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {isEditing ? <Save size={14} /> : <Send size={14} />}
          {saving ? 'Submitting...' : isEditing ? 'Update' : 'Submit to Meta'}
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm px-5 py-2">
          {error}
        </div>
      )}

      {template?.rejection_reason && (
        <div className="bg-red-500/10 border-b border-red-500/30 text-red-400 text-sm px-5 py-2">
          Rejection reason: {template.rejection_reason}
        </div>
      )}

      {isSubmitted && (
        <div className="bg-blue-500/10 border-b border-blue-500/30 text-blue-400 text-sm px-5 py-2">
          This template has been submitted to Meta and cannot be edited. Create a new template if you need changes.
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="flex gap-6 p-6 max-w-6xl">
          {/* Left: Form */}
          <div className="flex-1 space-y-5">
            {/* Name & Category */}
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
              <div>
                <label className="block text-sm mb-1.5">Template Name *</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. welcome_new_member"
                  disabled={isSubmitted}
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid disabled:opacity-50"
                />
                <p className="text-xs text-un1t-mid mt-1">Lowercase letters, numbers, and underscores only</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm mb-1.5">Category *</label>
                  <select
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    disabled={isSubmitted}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid disabled:opacity-50"
                  >
                    {CATEGORIES.map(c => (
                      <option key={c.value} value={c.value}>{c.label} — {c.description}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm mb-1.5">Language</label>
                  <select
                    value={language}
                    onChange={e => setLanguage(e.target.value)}
                    disabled={isSubmitted}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid disabled:opacity-50"
                  >
                    <option value="en">English</option>
                    <option value="en_US">English (US)</option>
                    <option value="en_GB">English (UK)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Header */}
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Header (optional)</h3>
              <select
                value={headerFormat}
                onChange={e => setHeaderFormat(e.target.value)}
                disabled={isSubmitted}
                className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid disabled:opacity-50"
              >
                {HEADER_FORMATS.map(h => (
                  <option key={h.value} value={h.value}>{h.label}</option>
                ))}
              </select>

              {headerFormat === 'TEXT' && (
                <input
                  type="text"
                  value={headerText}
                  onChange={e => setHeaderText(e.target.value)}
                  placeholder="Header text (max 60 chars)"
                  maxLength={60}
                  disabled={isSubmitted}
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid disabled:opacity-50"
                />
              )}

              {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && (
                <p className="text-xs text-un1t-mid">
                  Media will be provided when sending the broadcast. A placeholder URL is submitted for approval.
                </p>
              )}
            </div>

            {/* Body */}
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Body *</h3>
              <textarea
                value={bodyText}
                onChange={e => setBodyText(e.target.value)}
                placeholder="Hello {{1}}, welcome to {{2}}! Your trial starts today."
                rows={5}
                maxLength={1024}
                disabled={isSubmitted}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid resize-y disabled:opacity-50"
              />
              <p className="text-xs text-un1t-mid">
                Use {'{{1}}'}, {'{{2}}'}, etc. for variables. Max 1024 characters.
                Variables will be mapped to contact fields when sending.
              </p>
            </div>

            {/* Footer */}
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Footer (optional)</h3>
              <input
                type="text"
                value={footerText}
                onChange={e => setFooterText(e.target.value)}
                placeholder="e.g. Reply STOP to unsubscribe"
                maxLength={60}
                disabled={isSubmitted}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid disabled:opacity-50"
              />
            </div>

            {/* Buttons */}
            <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
              <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Buttons (optional, max 3)</h3>

              {buttons.map((btn, i) => (
                <div key={i} className="flex items-start gap-2 p-3 bg-un1t-dark rounded-lg border border-un1t-gray">
                  <div className="flex-1 space-y-2">
                    <div className="flex gap-2">
                      <select
                        value={btn.type}
                        onChange={e => updateButton(i, { type: e.target.value })}
                        disabled={isSubmitted}
                        className="bg-un1t-dark border border-un1t-gray rounded-md px-2 py-1.5 text-xs text-un1t-white focus:outline-none disabled:opacity-50"
                      >
                        <option value="QUICK_REPLY">Quick Reply</option>
                        <option value="URL">URL</option>
                        <option value="PHONE_NUMBER">Phone Number</option>
                      </select>
                      <input
                        type="text"
                        value={btn.text}
                        onChange={e => updateButton(i, { text: e.target.value })}
                        placeholder="Button text"
                        maxLength={25}
                        disabled={isSubmitted}
                        className="flex-1 bg-un1t-dark border border-un1t-gray rounded-md px-2 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none disabled:opacity-50"
                      />
                    </div>
                    {btn.type === 'URL' && (
                      <input
                        type="url"
                        value={btn.url || ''}
                        onChange={e => updateButton(i, { url: e.target.value })}
                        placeholder="https://..."
                        disabled={isSubmitted}
                        className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-2 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none disabled:opacity-50"
                      />
                    )}
                    {btn.type === 'PHONE_NUMBER' && (
                      <input
                        type="tel"
                        value={btn.phone_number || ''}
                        onChange={e => updateButton(i, { phone_number: e.target.value })}
                        placeholder="+353..."
                        disabled={isSubmitted}
                        className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-2 py-1.5 text-xs text-un1t-white placeholder:text-un1t-mid focus:outline-none disabled:opacity-50"
                      />
                    )}
                  </div>
                  {!isSubmitted && (
                    <button onClick={() => removeButton(i)} className="p-1 text-un1t-mid hover:text-red-400">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}

              {buttons.length < 3 && !isSubmitted && (
                <div className="flex gap-2">
                  <button onClick={() => addButton('QUICK_REPLY')} className="text-xs text-un1t-light hover:text-un1t-white border border-un1t-gray px-3 py-1.5 rounded-md transition-colors">
                    + Quick Reply
                  </button>
                  <button onClick={() => addButton('URL')} className="text-xs text-un1t-light hover:text-un1t-white border border-un1t-gray px-3 py-1.5 rounded-md transition-colors">
                    + URL Button
                  </button>
                  <button onClick={() => addButton('PHONE_NUMBER')} className="text-xs text-un1t-light hover:text-un1t-white border border-un1t-gray px-3 py-1.5 rounded-md transition-colors">
                    + Call Button
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Right: Preview */}
          <div className="w-80 shrink-0">
            <div className="sticky top-6">
              <h3 className="text-sm font-semibold text-un1t-light mb-3">Preview</h3>
              <div className="bg-[#e5ddd5] rounded-lg p-4">
                <div className="bg-white rounded-lg p-3 shadow-sm max-w-[260px]">
                  {headerFormat === 'TEXT' && headerText && (
                    <p className="text-sm font-bold text-gray-900 mb-1">{headerText}</p>
                  )}
                  {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && (
                    <div className="bg-gray-200 rounded h-32 flex items-center justify-center text-gray-400 text-xs mb-2">
                      [{headerFormat}]
                    </div>
                  )}
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">
                    {bodyText || 'Your message body here...'}
                  </p>
                  {footerText && (
                    <p className="text-xs text-gray-500 mt-2">{footerText}</p>
                  )}
                  <p className="text-[10px] text-gray-400 text-right mt-1">12:00</p>
                </div>
                {buttons.length > 0 && (
                  <div className="mt-1 space-y-1 max-w-[260px]">
                    {buttons.map((btn, i) => (
                      <div key={i} className="bg-white rounded-lg py-2 text-center shadow-sm">
                        <span className="text-sm text-blue-500">{btn.text || 'Button'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
