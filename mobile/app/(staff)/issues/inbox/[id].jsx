// W1 — issue triage: handler detail. Owner/master only. Shows the
// report + photos + submitter, then the actions for the current state:
//   open         → Claim (optional) · Resolve (notes required)
//   in_progress  → Resolve (notes required)
//   resolved     → Close (archive; server only closes a resolved issue)
//   closed       → read-only
// Resolve notes are mandatory (the submitter gets pushed them).
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Image, Pressable, TextInput } from 'react-native'
import { useLocalSearchParams, useRouter, useFocusEffect, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../../lib/auth-context'
import { canMobile } from '../../../../lib/permissions'
import {
  getInboxIssue, getInboxAttachmentUrl, claimIssue, resolveIssue, closeIssue,
  ISSUE_STATUS_LABELS, ISSUE_STATUS_TONE,
} from '../../../../lib/issues-api'
import { Button } from '../../../../components/ui'
import BackHeaderLeft from '../../../../components/BackHeaderLeft'

function StatusPill({ status }) {
  const tone = ISSUE_STATUS_TONE[status] || ISSUE_STATUS_TONE.open
  return (
    <View className={`${tone.bg} ${tone.border} border rounded-full px-2.5 py-0.5 self-start`}>
      <Text className={`${tone.fg} text-[11px] font-semibold uppercase tracking-wider`}>
        {ISSUE_STATUS_LABELS[status] || status}
      </Text>
    </View>
  )
}

function PhotoCard({ issueId, attachment }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    getInboxAttachmentUrl(issueId, attachment.id).then((r) => {
      if (!alive) return
      if (r.success === false || !r.data?.url) { setFailed(true); return }
      setUrl(r.data.url)
    })
    return () => { alive = false }
  }, [issueId, attachment.id])
  if (failed) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-xl items-center justify-center" style={{ height: 200 }}>
        <Ionicons name="warning-outline" size={20} color="#F59E0B" />
        <Text className="text-[11px] text-amber-700 mt-1">Could not load photo</Text>
      </View>
    )
  }
  if (!url) {
    return (
      <View className="bg-un1t-surface border border-un1t-border rounded-xl items-center justify-center" style={{ height: 200 }}>
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }
  return <Image source={{ uri: url }} resizeMode="cover" style={{ width: '100%', height: 240, borderRadius: 12 }} />
}

function fmtWhen(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function IssueInboxDetail() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canTriage = canMobile(profile, 'issue_triage', activeLocation)

  const [issue, setIssue] = useState(null)
  const [error, setError] = useState(null)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(null)        // 'claim' | 'resolve' | 'close' | null
  const [actionError, setActionError] = useState(null)

  const load = useCallback(async () => {
    const r = await getInboxIssue(id)
    if (r.success === false) { setError(r.error || 'Could not load issue'); setIssue(null); return }
    setError(null)
    setIssue(r.data)
  }, [id])

  useFocusEffect(useCallback(() => {
    if (!canTriage) return
    load().catch(() => {})
  }, [canTriage, load]))

  // Return to the inbox — guard for the cold-start / deep-link case where
  // there's nothing to pop back to (NOTIF.2 lesson).
  function goBack() {
    if (router.canGoBack()) router.back()
    else router.replace('/issues/inbox')
  }

  async function doClaim() {
    setBusy('claim'); setActionError(null)
    const r = await claimIssue(id)
    setBusy(null)
    // Reconcile the UI to the server's current state either way — on a
    // concurrency 409 (someone else claimed) this flips us to in_progress.
    await load()
    if (r.success === false) setActionError(r.error || 'Could not claim')
  }

  async function doResolve() {
    if (!notes.trim()) { setActionError('Add a short note on how it was resolved.'); return }
    setBusy('resolve'); setActionError(null)
    const r = await resolveIssue(id, notes.trim())
    setBusy(null)
    if (r.success === false) { setActionError(r.error || 'Could not resolve'); return }
    goBack()
  }

  async function doClose() {
    setBusy('close'); setActionError(null)
    const r = await closeIssue(id)
    setBusy(null)
    if (r.success === false) { setActionError(r.error || 'Could not close'); return }
    goBack()
  }

  const isHistory = issue && (issue.status === 'resolved' || issue.status === 'closed')

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Issue', headerLeft: () => <BackHeaderLeft label="Inbox" fallbackHref="/issues/inbox" tint="#FFFFFF" /> }} />

      {!canTriage ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Triage is owner/master only.</Text>
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center p-6">
          <Ionicons name="alert-circle-outline" size={40} color="#EF4444" />
          <Text className="text-sm text-un1t-subtle text-center mt-3 mb-4">{error}</Text>
          <Pressable onPress={load} className="bg-un1t-surface border border-un1t-border px-5 py-2.5 rounded-xl active:opacity-80">
            <Text className="text-un1t-text font-semibold">Try again</Text>
          </Pressable>
        </View>
      ) : !issue ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <View className="flex-row items-center gap-2 mb-2">
            <StatusPill status={issue.status} />
            <Text className="text-[11px] text-un1t-subtle">
              {issue.submitter?.full_name ? `${issue.submitter.full_name} · ` : ''}{fmtWhen(issue.created_at)}
            </Text>
          </View>

          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4">
            <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">The report</Text>
            <Text className="text-base text-un1t-text">{issue.description}</Text>
          </View>

          {Array.isArray(issue.issue_attachments) && issue.issue_attachments.length > 0 && (
            <View className="mb-4">
              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2 px-1">Photos</Text>
              <View className="gap-3">
                {issue.issue_attachments
                  .slice()
                  .sort((a, b) => (a.position || 0) - (b.position || 0))
                  .map(a => <PhotoCard key={a.id} issueId={issue.id} attachment={a} />)}
              </View>
            </View>
          )}

          {actionError && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{actionError}</Text>
            </View>
          )}

          {isHistory ? (
            <View>
              <View className="bg-green-500/10 border border-green-500/30 rounded-2xl p-4">
                <View className="flex-row items-center gap-2 mb-1">
                  <Ionicons name="checkmark-circle" size={16} color="#16A34A" />
                  <Text className="text-xs font-semibold uppercase tracking-wider text-green-700">
                    {issue.status === 'closed' ? 'Closed' : 'Resolved'} {issue.resolved_at ? fmtWhen(issue.resolved_at) : ''}
                  </Text>
                </View>
                {issue.resolution_notes
                  ? <Text className="text-base text-un1t-text mt-1">{issue.resolution_notes}</Text>
                  : <Text className="text-sm text-un1t-subtle mt-1">No notes added.</Text>}
              </View>

              {/* The server only closes a RESOLVED issue (archive step). */}
              {issue.status === 'resolved' && (
                <View className="mt-4">
                  <Button variant="secondary" label={busy === 'close' ? 'Closing…' : 'Close issue'} onPress={doClose} disabled={!!busy} loading={busy === 'close'} />
                  <Text className="text-[11px] text-un1t-subtle text-center mt-2">Archives this resolved issue.</Text>
                </View>
              )}
            </View>
          ) : (
            <View>
              {issue.status === 'open' && (
                <View className="mb-3">
                  <Button variant="secondary" label={busy === 'claim' ? 'Claiming…' : 'Claim · I’m on it'} onPress={doClaim} disabled={!!busy} loading={busy === 'claim'} />
                </View>
              )}

              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Resolution note</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                placeholder="What did you do to fix it?"
                placeholderTextColor="#94A3B8"
                multiline
                className="rounded-xl border border-un1t-border bg-white px-3 py-2 text-un1t-text mb-3"
                style={{ minHeight: 64 }}
              />
              <Button label={busy === 'resolve' ? 'Resolving…' : 'Resolve & notify submitter'} onPress={doResolve} disabled={!!busy || !notes.trim()} loading={busy === 'resolve'} />
            </View>
          )}
        </ScrollView>
      )}
    </View>
  )
}
