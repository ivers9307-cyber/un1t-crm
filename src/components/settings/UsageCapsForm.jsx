'use client'

// SAAS4-M3 — the org hard-cap editor on /settings/usage. Owner/master
// only (server-enforced on the PUT; `canEdit` just hides the form).
// Empty input = no cap. Values are entered in whole currency / sends
// and stored as cents / count.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function UsageCapsForm({ organizationId, canEdit, initialAiCapCents, initialEmailCapSends, initialOpsEmails, initialVoice = null, initialVoiceReplies = null, initialAssistantCapCents = null, assistantSpendCents = null }) {
  const router = useRouter()
  const [aiCap, setAiCap] = useState(initialAiCapCents != null ? String(initialAiCapCents / 100) : '')
  // ASSISTCAP.1 - the staff assistant's own cap, separate from Mia's above.
  const [assistantCap, setAssistantCap] = useState(initialAssistantCapCents != null ? String(initialAssistantCapCents / 100) : '')
  const [emailCap, setEmailCap] = useState(initialEmailCapSends != null ? String(initialEmailCapSends) : '')
  const [opsEmails, setOpsEmails] = useState(Array.isArray(initialOpsEmails) ? initialOpsEmails.join(', ') : '')
  // VOICENOTE.1 — WhatsApp voice-note transcription (ElevenLabs), per org.
  const [voiceOn, setVoiceOn] = useState(initialVoice?.enabled === true)
  const [voiceCap, setVoiceCap] = useState(initialVoice?.capMinutes != null ? String(initialVoice.capMinutes) : '')
  const voiceUsed = initialVoice?.usedMinutes == null ? '—' : String(initialVoice.usedMinutes)
  // VOICEREPLY.1 — Mia's voice replies, per org.
  const [replyMode, setReplyMode] = useState(initialVoiceReplies?.mode || 'off')
  const [replyPhones, setReplyPhones] = useState((initialVoiceReplies?.testPhones || []).join(', '))
  const [replyCap, setReplyCap] = useState(initialVoiceReplies?.cap != null ? String(initialVoiceReplies.cap) : '')
  const repliesUsed = initialVoiceReplies?.usedThisMonth == null ? '—' : String(initialVoiceReplies.usedThisMonth)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  if (!canEdit) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 text-sm text-un1t-subtle">
        Hard caps are set by an owner. Current: AI{' '}
        {initialAiCapCents != null ? `$${(initialAiCapCents / 100).toFixed(2)}/mo` : 'no cap'} · Staff assistant{' '}
        {initialAssistantCapCents != null ? `$${(initialAssistantCapCents / 100).toFixed(2)}/mo` : 'no cap'} · Email{' '}
        {initialEmailCapSends != null ? `${initialEmailCapSends.toLocaleString()} sends/mo` : 'no cap'}.
        {initialVoice && (
          <>
            {' '}Voice notes: {initialVoice.enabled ? 'on' : 'off'}, {initialVoice.capMinutes != null ? `${initialVoice.capMinutes} minutes/mo` : 'no limit'}, {voiceUsed} used.
          </>
        )}
      </div>
    )
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)

    const aiNum = aiCap.trim() === '' ? null : Number(aiCap)
    const assistantNum = assistantCap.trim() === '' ? null : Number(assistantCap)
    const emailNum = emailCap.trim() === '' ? null : Number(emailCap)
    if (aiNum != null && (!Number.isFinite(aiNum) || aiNum <= 0)) {
      setError('AI cap must be a positive amount, or blank for no cap.')
      setSaving(false)
      return
    }
    if (assistantNum != null && (!Number.isFinite(assistantNum) || assistantNum <= 0)) {
      setError('Staff assistant cap must be a positive amount, or blank for no cap.')
      setSaving(false)
      return
    }
    if (emailNum != null && (!Number.isInteger(emailNum) || emailNum <= 0)) {
      setError('Email cap must be a positive whole number of sends, or blank for no cap.')
      setSaving(false)
      return
    }
    const replyCapNum = replyCap.trim() === '' ? null : Number(replyCap)
    if (replyCapNum != null && (!Number.isInteger(replyCapNum) || replyCapNum <= 0)) {
      setError('Voice reply limit must be a positive whole number, or blank for no limit.')
      setSaving(false)
      return
    }
    const replyPhoneList = replyPhones.split(',').map((p) => p.trim()).filter(Boolean)
    const voiceNum = voiceCap.trim() === '' ? null : Number(voiceCap)
    if (voiceNum != null && (!Number.isInteger(voiceNum) || voiceNum <= 0)) {
      setError('Voice note limit must be a positive whole number of minutes, or blank for no limit.')
      setSaving(false)
      return
    }

    let json
    try {
      const res = await fetch('/api/settings/org-usage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: organizationId,
          ai_hard_cap_cents: aiNum == null ? null : Math.round(aiNum * 100),
          assistant_hard_cap_cents: assistantNum == null ? null : Math.round(assistantNum * 100),
          email_hard_cap_sends: emailNum,
          // SAAS4-O2 — comma string; server normalises/validates.
          ops_alert_emails: opsEmails.trim() === '' ? null : opsEmails,
          voice_transcription_enabled: voiceOn,
          voice_transcription_monthly_cap_minutes: voiceNum,
          voice_reply_mode: replyMode,
          voice_reply_test_phones: replyPhoneList,
          voice_reply_monthly_cap: replyCapNum,
        }),
      })
      json = await res.json()
    } catch {
      json = { success: false, error: 'Network error saving caps. Try again.' }
    }
    if (!json.success) {
      setError(json.error || 'Failed to save caps.')
      setSaving(false)
      return
    }
    setSaved(true)
    setSaving(false)
    router.refresh()
  }

  return (
    <form onSubmit={save} className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="text-sm font-medium mb-1">Hard caps</div>
      <p className="text-xs text-un1t-subtle mb-4 max-w-xl">
        Optional monthly brakes. Blank = no cap. At the AI cap, Mia pauses with a human handoff.
        The staff assistant has its OWN cap and its own spend: the two never share a budget, so
        staff experimenting can never pause Mia, and a busy month of customer replies can never
        switch the assistant off. At the email cap, new campaigns are refused (sequences and
        reminders keep working). Managers get one heads-up at 80% of each cap.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-3">
          {error}
        </div>
      )}
      {saved && !error && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-700 text-sm rounded-lg p-3 mb-3">
          Caps saved.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4 max-w-xl">
        <label className="block text-sm">
          <span className="text-un1t-text">AI hard cap ($ per month, est.)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={aiCap}
            onChange={(e) => setAiCap(e.target.value)}
            placeholder="No cap"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-un1t-text">Staff assistant cap ($ per month, est.)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={assistantCap}
            onChange={(e) => setAssistantCap(e.target.value)}
            placeholder="No cap"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-un1t-subtle">
            {assistantSpendCents == null
              ? 'Separate from the AI cap. At the cap the assistant refuses; Mia is unaffected.'
              : `$${(assistantSpendCents / 100).toFixed(2)} spent this month. At the cap the assistant refuses; Mia is unaffected.`}
          </span>
        </label>
        <label className="block text-sm">
          <span className="text-un1t-text">Email hard cap (sends per month)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={emailCap}
            onChange={(e) => setEmailCap(e.target.value)}
            placeholder="No cap"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </div>

      <label className="block text-sm mb-4 max-w-xl">
        <span className="text-un1t-text">Ops alert emails</span>
        <input
          value={opsEmails}
          onChange={(e) => setOpsEmails(e.target.value)}
          placeholder="ops@yourgym.ie, owner@yourgym.ie"
          className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
        />
        <span className="text-xs text-un1t-subtle">
          Where cap warnings and sync-stale alerts go, comma-separated. Blank = platform admin only.
        </span>
      </label>

      <fieldset className="mb-4 max-w-xl border-t border-un1t-border pt-4">
        <legend className="text-sm font-medium">Voice notes</legend>
        <label htmlFor="voice-transcription-enabled" className="flex items-center gap-2 text-sm mt-2">
          <input
            id="voice-transcription-enabled"
            type="checkbox"
            checked={voiceOn}
            onChange={(e) => setVoiceOn(e.target.checked)}
          />
          <span className="text-un1t-text">Transcribe WhatsApp voice notes</span>
        </label>
        <label htmlFor="voice-transcription-cap" className="block text-sm mt-3 sm:w-1/2">
          <span className="text-un1t-text">Monthly limit (minutes)</span>
          <input
            id="voice-transcription-cap"
            type="number"
            min="1"
            step="1"
            value={voiceCap}
            onChange={(e) => setVoiceCap(e.target.value)}
            placeholder="No limit"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <p className="text-xs text-un1t-subtle mt-2">{voiceUsed} minutes used this month</p>
        <p className="text-xs text-un1t-subtle mt-1">Voice notes are sent to ElevenLabs to be transcribed.</p>
      </fieldset>

      <fieldset className="mb-4 max-w-xl border-t border-un1t-border pt-4">
        <legend className="text-sm font-medium">Voice replies</legend>
        <p className="text-xs text-un1t-subtle mt-1">When a customer sends a voice note, Mia replies with one. Studios pick her voices on the customer agent page.</p>
        <label htmlFor="voice-reply-mode" className="block text-sm mt-3 sm:w-1/2">
          <span className="text-un1t-text">Voice replies</span>
          <select
            id="voice-reply-mode"
            value={replyMode}
            onChange={(e) => setReplyMode(e.target.value)}
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="off">Off</option>
            <option value="test">Test numbers only</option>
            <option value="on">On</option>
          </select>
        </label>
        <label htmlFor="voice-reply-phones" className="block text-sm mt-3">
          <span className="text-un1t-text">Test numbers</span>
          <input
            id="voice-reply-phones"
            value={replyPhones}
            onChange={(e) => setReplyPhones(e.target.value)}
            placeholder="+353 87 123 4567"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <p className="text-xs text-un1t-subtle">Comma-separated. Only these numbers get voice replies while the setting is &ldquo;Test numbers only&rdquo;.</p>
        <label htmlFor="voice-reply-cap" className="block text-sm mt-3 sm:w-1/2">
          <span className="text-un1t-text">Monthly limit (voice replies)</span>
          <input
            id="voice-reply-cap"
            type="number"
            min="1"
            step="1"
            value={replyCap}
            onChange={(e) => setReplyCap(e.target.value)}
            placeholder="No limit"
            className="mt-1 w-full bg-un1t-bg border border-un1t-border rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <p className="text-xs text-un1t-subtle mt-2">{repliesUsed} voice replies this month</p>
        <p className="text-xs text-un1t-subtle mt-1">Mia&rsquo;s written reply is sent to ElevenLabs to be turned into speech.</p>
      </fieldset>

      <button
        type="submit"
        disabled={saving}
        className="bg-un1t-text text-un1t-bg text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save caps'}
      </button>
    </form>
  )
}
