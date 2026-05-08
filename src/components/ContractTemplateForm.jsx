'use client'

// Markdown editor for contract templates. Two-pane layout on
// desktop (editor on the left, live preview on the right with
// fake-data substitution); single-column on mobile with a tab
// toggle.
//
// Variables panel:
//   - Read-only list of profile-derived auto-fills (full_name,
//     annual_salary, hourly_rate, ...). Click to insert at cursor.
//   - Editable list of custom variables (key/label/type/required).
//     New ones can be added; existing ones can be removed.
//
// The preview substitutes a realistic dummy profile so the issuer
// can see what the rendered document will roughly look like
// before issuing. At issue time the actual recipient's data
// replaces the dummy values.

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, FileText } from 'lucide-react'
import { renderTemplate, profileVariables } from '@/lib/contracts'

const SAMPLE_PROFILE = {
  full_name: 'Sample Recipient',
  email: 'sample@un1tdublin.com',
  role: 'staff',
  employment_type: 'fte',
  annual_salary: 60000,
  hourly_rate: 28,
  overtime_rate: 42,
  contracted_hours_per_week: 37.5,
}

// Reference table rendered under the markdown editor. Each row is
// a variable that's auto-filled from the recipient's profile (or
// computed) at issue time. Group is just for visual section
// headers — keeps identity / compensation / dates separated so
// the table scans quickly.
const PROFILE_VAR_HELP = [
  { group: 'Identity', key: 'full_name',           sample: 'Sarah Doe',                       desc: 'Recipient\'s full name from their profile.' },
  { group: 'Identity', key: 'email',               sample: 'sarah@un1tdublin.com',            desc: 'Recipient\'s email address.' },
  { group: 'Identity', key: 'role',                sample: 'staff',                           desc: 'Role label (master/owner/manager/head_coach/staff).' },
  { group: 'Identity', key: 'employment_type',     sample: 'fte',                             desc: 'fte or contractor.' },
  { group: 'Compensation', key: 'annual_salary',           sample: '€60,000',  desc: 'Annual salary, Irish-locale formatted (FTE).' },
  { group: 'Compensation', key: 'annual_salary_raw',       sample: '60000',    desc: 'Raw numeric for arithmetic.' },
  { group: 'Compensation', key: 'hourly_rate',             sample: '€28',      desc: 'Hourly rate (also acts as contractor rate).' },
  { group: 'Compensation', key: 'hourly_rate_raw',         sample: '28',       desc: 'Raw numeric.' },
  { group: 'Compensation', key: 'overtime_rate',           sample: '€42',      desc: 'Overtime / premium rate.' },
  { group: 'Compensation', key: 'overtime_rate_raw',       sample: '42',       desc: 'Raw numeric.' },
  { group: 'Compensation', key: 'contracted_hours_per_week', sample: '37.5',   desc: 'Contracted weekly hours.' },
  { group: 'Dates',    key: 'today',               sample: '2026-05-08',                      desc: 'Today\'s date in ISO format. Auto-filled.' },
]

export default function ContractTemplateForm({ initial, isEdit = false }) {
  const router = useRouter()
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [employmentType, setEmploymentType] = useState(initial?.employment_type || 'both')
  const [body, setBody] = useState(initial?.body_markdown || DEFAULT_BODY)
  const [vars, setVars] = useState(initial?.variables_schema || [])
  const [active, setActive] = useState(initial?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('write') // mobile-only: write | preview

  // Live preview — substitute sample data so the issuer can see
  // a realistic-looking rendered document. Custom variables get
  // their key as the value if no sample is provided.
  const preview = useMemo(() => {
    const sampleCustom = {}
    for (const v of (vars || [])) {
      sampleCustom[v.key] = `[${v.label}]`
    }
    const merged = { ...profileVariables(SAMPLE_PROFILE), ...sampleCustom }
    return renderTemplate(body, merged)
  }, [body, vars])

  function addVar() {
    setVars(v => [...v, { key: '', label: '', type: 'text', required: false }])
  }

  function updateVar(idx, patch) {
    setVars(v => v.map((row, i) => (i === idx ? { ...row, ...patch } : row)))
  }

  function removeVar(idx) {
    setVars(v => v.filter((_, i) => i !== idx))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const payload = {
      name,
      description: description || null,
      body_markdown: body,
      variables_schema: vars.filter(v => v.key && v.label),
      employment_type: employmentType,
      active,
    }
    const url = isEdit ? `/api/contract-templates/${initial.id}` : '/api/contract-templates'
    const method = isEdit ? 'PATCH' : 'POST'
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      router.push('/admin/contracts/templates')
      router.refresh()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Top row — name + employment_type + description */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-un1t-light mb-1">Template name</label>
          <input
            type="text"
            required
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. UN1T Coach FTE Contract v1"
            className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-un1t-light mb-1">Employment type</label>
          <select
            value={employmentType}
            onChange={e => setEmploymentType(e.target.value)}
            className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm"
          >
            <option value="both">FTE or contractor</option>
            <option value="fte">FTE only</option>
            <option value="contractor">Contractor only</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm text-un1t-light mb-1">Description (optional)</label>
        <input
          type="text"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Internal note — not shown to the recipient"
          className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm"
        />
      </div>

      {/* Custom variables manager */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Custom variables</h3>
          <button
            type="button"
            onClick={addVar}
            className="text-xs px-2 py-1 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white inline-flex items-center gap-1"
          >
            <Plus size={11} /> Add
          </button>
        </div>
        <p className="text-[11px] text-un1t-light mb-3">
          Custom variables are filled in by the issuer at issue time (e.g. start_date, notice_period).
          Profile-derived variables are auto-filled — no need to declare those here.
        </p>
        {vars.length === 0 ? (
          <p className="text-xs text-un1t-mid italic">No custom variables. Add one if your template references something not in the profile.</p>
        ) : (
          <div className="space-y-2">
            {vars.map((v, idx) => (
              <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
                <input
                  type="text"
                  value={v.key}
                  onChange={e => updateVar(idx, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
                  placeholder="key (e.g. start_date)"
                  className="sm:col-span-3 bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-xs font-mono"
                />
                <input
                  type="text"
                  value={v.label}
                  onChange={e => updateVar(idx, { label: e.target.value })}
                  placeholder="label shown in wizard"
                  className="sm:col-span-4 bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-xs"
                />
                <select
                  value={v.type}
                  onChange={e => updateVar(idx, { type: e.target.value })}
                  className="sm:col-span-2 bg-un1t-black border border-un1t-gray rounded-md px-2 py-1.5 text-xs"
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="date">date</option>
                </select>
                <label className="sm:col-span-2 flex items-center gap-1.5 text-xs text-un1t-light">
                  <input
                    type="checkbox"
                    checked={!!v.required}
                    onChange={e => updateVar(idx, { required: e.target.checked })}
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => removeVar(idx)}
                  className="sm:col-span-1 text-un1t-light hover:text-red-700 inline-flex items-center justify-center"
                  title="Remove variable"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mobile tab toggle */}
      <div className="md:hidden flex border-b border-un1t-gray">
        <button
          type="button"
          onClick={() => setTab('write')}
          className={`flex-1 py-2 text-sm ${tab === 'write' ? 'border-b-2 border-un1t-white' : 'text-un1t-light'}`}
        >Write</button>
        <button
          type="button"
          onClick={() => setTab('preview')}
          className={`flex-1 py-2 text-sm ${tab === 'preview' ? 'border-b-2 border-un1t-white' : 'text-un1t-light'}`}
        >Preview</button>
      </div>

      {/* Two-pane editor / preview */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className={`${tab === 'preview' ? 'hidden md:block' : ''}`}>
          <label className="block text-sm text-un1t-light mb-1">Body (markdown)</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={20}
            className="w-full bg-un1t-dark border border-un1t-gray rounded-md px-3 py-2 text-sm font-mono"
            placeholder="# Contract&#10;&#10;This Agreement is between UN1T Dublin Ltd and {{full_name}}..."
          />
          <details className="mt-3 text-xs text-un1t-light" open>
            <summary className="cursor-pointer font-semibold text-un1t-white mb-2">
              Available auto-fill variables
            </summary>
            <p className="text-[11px] text-un1t-light mb-2">
              Drop these directly into the body — they&apos;re replaced with the recipient&apos;s real
              values at issue time. The custom variables you defined above appear in the issue
              wizard for the issuer to fill in.
            </p>
            <div className="overflow-x-auto border border-un1t-gray rounded-md">
              <table className="w-full text-[11px] min-w-[480px]">
                <thead className="bg-un1t-gray/30">
                  <tr className="text-left text-un1t-light uppercase tracking-wider text-[10px]">
                    <th className="px-3 py-2">Variable</th>
                    <th className="px-3 py-2">Sample</th>
                    <th className="px-3 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const out = []
                    let lastGroup = null
                    PROFILE_VAR_HELP.forEach(v => {
                      if (v.group !== lastGroup) {
                        out.push(
                          <tr key={`g-${v.group}`}>
                            <td colSpan={3} className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-un1t-mid">
                              {v.group}
                            </td>
                          </tr>
                        )
                        lastGroup = v.group
                      }
                      out.push(
                        <tr key={v.key} className="border-t border-un1t-gray/40 align-top">
                          <td className="px-3 py-2"><code className="text-un1t-white">{`{{${v.key}}}`}</code></td>
                          <td className="px-3 py-2 text-un1t-mid font-mono">{v.sample}</td>
                          <td className="px-3 py-2 text-un1t-light">{v.desc}</td>
                        </tr>
                      )
                    })
                    return out
                  })()}
                </tbody>
              </table>
            </div>
          </details>
        </div>
        <div className={`${tab === 'write' ? 'hidden md:block' : ''}`}>
          <label className="block text-sm text-un1t-light mb-1">Live preview</label>
          <div className="bg-white text-gray-900 border border-un1t-gray rounded-md p-4 min-h-[400px] whitespace-pre-wrap text-sm leading-relaxed">
            {preview || <span className="text-gray-400">Start typing in the body…</span>}
          </div>
          <p className="text-[10px] text-un1t-mid mt-1">
            Preview uses sample profile data ({SAMPLE_PROFILE.full_name}, salary {`{{annual_salary}}`} etc.). At issue time the recipient&apos;s real values replace these.
          </p>
        </div>
      </div>

      {isEdit && (
        <label className="flex items-center gap-2 text-sm text-un1t-light">
          <input
            type="checkbox"
            checked={active}
            onChange={e => setActive(e.target.checked)}
          />
          Active (appears in the issue picker)
        </label>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push('/admin/contracts/templates')}
          className="text-xs px-3 py-1.5 rounded-md border border-un1t-gray text-un1t-light hover:text-un1t-white"
        >Cancel</button>
        <button
          type="submit"
          disabled={busy || !name || !body}
          className="text-xs bg-un1t-white text-un1t-black px-4 py-1.5 rounded-md font-medium hover:bg-un1t-accent disabled:opacity-50"
        >
          <FileText size={12} className="inline -mt-0.5 mr-1" />
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create template'}
        </button>
      </div>
    </form>
  )
}

const DEFAULT_BODY = `# Employment Agreement

This Agreement is made between UN1T Dublin Ltd ("UN1T") and {{full_name}} ("the Employee") on {{today}}.

## 1. Position
The Employee will be employed as a {{role}}, reporting to a UN1T Dublin manager.

## 2. Compensation
- Annual salary: {{annual_salary}}
- Hourly rate (where applicable): {{hourly_rate}}
- Contracted hours per week: {{contracted_hours_per_week}}

## 3. Start date
{{start_date}}

## 4. Notice period
{{notice_period_weeks}} weeks.

---

By countersigning at issue and signing electronically in the UN1T staff portal, both parties agree to the terms above.
`
