// SPEND.P3 (mobile) — company-card receipt detail.
//
// Surfaces all fields + status, a "View receipt" button (opens the
// signed URL in the external browser via expo-web-browser), an audit
// timeline, and actions:
//   • Approve + Decline-with-reason — owner/master on a submitted row.
//   • Revoke — the submitter on their own submitted row.
// The approve / decline / revoke routes enforce owner-at-location /
// master / ownership server-side; this UI only mirrors that.
//
// Mirrors invoices/[id].jsx. Uses BackHeaderLeft because this screen is
// pushed from the /card-receipts list across the tab→stack navigator
// boundary, so iOS won't auto-render a chevron.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  Alert, RefreshControl, TextInput,
} from 'react-native'
import { useLocalSearchParams, useRouter, useFocusEffect, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as WebBrowser from 'expo-web-browser'
import {
  getCardReceipt, getCardReceiptUrl,
  approveCardReceipt, declineCardReceipt, revokeCardReceipt,
  formatPurchaseDate,
} from '../../lib/card-receipts-api'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const STATUS_STYLE = {
  submitted: { label: 'Awaiting review', tint: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700', icon: 'time-outline' },
  // Owner-approved → awaiting the bookkeeper's Xero sign-off (web). From
  // the submitter/owner view it reads as "Approved".
  awaiting_accountant_review: { label: 'Approved', tint: '#059669', bg: 'bg-green-500/20', text: 'text-green-700', icon: 'checkmark-circle-outline' },
  declined:  { label: 'Declined',        tint: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700',   icon: 'close-circle-outline' },
  revoked:   { label: 'Revoked',         tint: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700', icon: 'arrow-undo-outline' },
}

export default function CardReceiptDetailScreen() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [receiptLoading, setReceiptLoading] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState(null)

  const fetchDetail = useCallback(async () => {
    setError(null)
    const r = await getCardReceipt(id)
    if (r.success === false) {
      setError(r.error || 'Failed to load')
    } else {
      setData(r.data)
    }
  }, [id])

  useEffect(() => {
    setLoading(true)
    fetchDetail().finally(() => setLoading(false))
  }, [fetchDetail])
  useFocusEffect(useCallback(() => { fetchDetail() }, [fetchDetail]))

  async function onRefresh() {
    setRefreshing(true)
    await fetchDetail()
    setRefreshing(false)
  }

  async function handleViewReceipt() {
    setReceiptLoading(true)
    try {
      const r = await getCardReceiptUrl(id)
      if (r.success && r.url) {
        await WebBrowser.openBrowserAsync(r.url)
      } else {
        Alert.alert('Receipt unavailable', r.error || 'Unknown error')
      }
    } finally {
      setReceiptLoading(false)
    }
  }

  function confirmRevoke() {
    Alert.alert(
      'Revoke this submission?',
      'It stays in your history (and the approver\'s audit trail) but is no longer in the review queue. You can submit a fresh receipt for the same purchase afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: doRevoke },
      ]
    )
  }

  async function doRevoke() {
    setBusy('revoke')
    const r = await revokeCardReceipt(id)
    setBusy(null)
    if (r.success) {
      await fetchDetail()
    } else {
      Alert.alert('Revoke failed', r.error || 'Unknown error')
    }
  }

  // Approver actions (owner/master). The routes enforce owner-at-location
  // / master independently of this UI.
  async function doApprove() {
    setBusy('approve'); setActionError(null)
    const r = await approveCardReceipt(id)
    setBusy(null)
    if (r.success === false) { setActionError(r.error || 'Could not approve'); return }
    await fetchDetail()
  }
  async function doDecline() {
    if (!reason.trim()) { setActionError('Add a reason so the card holder can fix it.'); return }
    setBusy('decline'); setActionError(null)
    const r = await declineCardReceipt(id, reason.trim())
    setBusy(null)
    if (r.success === false) { setActionError(r.error || 'Could not decline'); return }
    setDeclining(false); setReason('')
    await fetchDetail()
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }
  if (error || !data) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-red-700">{error || 'Not found'}</Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  const status = STATUS_STYLE[data.status] || STATUS_STYLE.submitted
  const isApprover = data.viewer_role === 'owner' || data.viewer_role === 'master'
  const isSubmitter = data.viewer_role === 'submitter'

  return (
    <>
      <Stack.Screen
        options={{
          title: data.merchant || 'Receipt',
          headerLeft: () => <BackHeaderLeft label="Card receipts" fallbackHref="/card-receipts" />,
        }}
      />
      <ScrollView
        className="flex-1 bg-un1t-bg"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        {/* Header */}
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
          {data.merchant ? (
            <>
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Merchant</Text>
              <Text className="text-xl font-bold text-un1t-text mb-3">{data.merchant}</Text>
            </>
          ) : null}

          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Amount</Text>
          <Text className="text-2xl font-bold text-un1t-text mb-1">
            €{Number(data.amount).toFixed(2)}
          </Text>
          {data.vat_amount != null && (
            <Text className="text-xs text-un1t-subtle mb-3">
              incl. €{Number(data.vat_amount).toFixed(2)} VAT
            </Text>
          )}

          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Purchase date</Text>
          <Text className="text-sm text-un1t-text mb-3">{formatPurchaseDate(data.purchase_date)}</Text>

          {data.card_last4 ? (
            <>
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Card</Text>
              <Text className="text-sm text-un1t-text mb-3">•••• {data.card_last4}</Text>
            </>
          ) : null}

          {data.description ? (
            <>
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Description</Text>
              <Text className="text-sm text-un1t-text mb-3">{data.description}</Text>
            </>
          ) : null}

          {data.location?.name ? (
            <Text className="text-xs text-un1t-subtle mb-3">{data.location.name}</Text>
          ) : null}

          <View className={`px-2 py-1 rounded-full flex-row items-center self-start ${status.bg}`}>
            <Ionicons name={status.icon} size={12} color={status.tint} />
            <Text className={`text-[11px] uppercase font-medium ml-1 ${status.text}`}>
              {status.label}
            </Text>
          </View>
        </View>

        {/* Decline reason banner */}
        {data.status === 'declined' && data.decline_reason && (
          <View className="bg-amber-500/10 border-l-4 border-amber-500 p-4 mb-4 rounded-r-2xl">
            <Text className="text-xs uppercase font-semibold text-amber-700 mb-1">Reason for decline</Text>
            <Text className="text-sm text-un1t-text">{data.decline_reason}</Text>
            {isSubmitter && (
              <Pressable
                onPress={() => router.push('/card-receipts/new')}
                className="mt-3 bg-blue-600 active:opacity-80 px-4 py-2.5 rounded-xl items-center"
              >
                <Text className="text-sm font-semibold text-white">Submit a corrected receipt</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Receipt view */}
        <Pressable
          onPress={handleViewReceipt}
          disabled={receiptLoading}
          className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4 flex-row items-center active:opacity-70"
        >
          <View className="w-10 h-10 rounded-full bg-blue-500/20 items-center justify-center">
            {receiptLoading
              ? <ActivityIndicator color="#2563EB" />
              : <Ionicons name="document-text" size={20} color="#2563EB" />}
          </View>
          <View className="flex-1 ml-3">
            <Text className="text-sm font-semibold text-un1t-text">View receipt</Text>
            <Text className="text-xs text-un1t-subtle">Opens in your browser</Text>
          </View>
          <Ionicons name="open-outline" size={18} color="#64748B" />
        </Pressable>

        {/* Approver actions — owner/master reviewing a submitted receipt. */}
        {isApprover && data.status === 'submitted' && (
          <View className="mb-4">
            {data.submitter?.full_name && (
              <Text className="text-xs text-un1t-subtle mb-2 px-1">Submitted by {data.submitter.full_name}</Text>
            )}
            {actionError && (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                <Text className="text-red-500 text-sm">{actionError}</Text>
              </View>
            )}
            {!declining ? (
              <View className="flex-row gap-2">
                <Pressable onPress={doApprove} disabled={!!busy} className="flex-1 bg-green-600 active:opacity-80 px-4 py-3 rounded-xl items-center flex-row justify-center">
                  {busy === 'approve' ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
                  <Text className="text-sm font-semibold text-white ml-2">Approve</Text>
                </Pressable>
                <Pressable onPress={() => { setDeclining(true); setActionError(null) }} disabled={!!busy} className="flex-1 bg-red-500/15 border border-red-500/30 active:opacity-70 px-4 py-3 rounded-xl items-center flex-row justify-center">
                  <Ionicons name="close" size={16} color="#DC2626" />
                  <Text className="text-sm font-semibold text-red-700 ml-2">Decline</Text>
                </Pressable>
              </View>
            ) : (
              <View>
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Why is this declined? (sent to the card holder)"
                  placeholderTextColor="#94A3B8"
                  multiline
                  className="rounded-xl border border-un1t-border bg-white px-3 py-2 text-un1t-text mb-2"
                  style={{ minHeight: 64 }}
                />
                <Pressable onPress={doDecline} disabled={!!busy || !reason.trim()} className={`px-4 py-3 rounded-xl items-center flex-row justify-center ${!reason.trim() ? 'bg-red-500/30' : 'bg-red-600 active:opacity-80'}`}>
                  {busy === 'decline' ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="close-circle" size={16} color="#FFFFFF" />}
                  <Text className="text-sm font-semibold text-white ml-2">Confirm decline</Text>
                </Pressable>
                <Pressable onPress={() => { setDeclining(false); setReason(''); setActionError(null) }} className="items-center mt-2" hitSlop={8}>
                  <Text className="text-sm text-un1t-subtle">Cancel</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}

        {/* Audit timeline */}
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4">
          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-3">Audit trail</Text>
          <Timeline data={data} />
        </View>

        {data.notes ? (
          <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4">
            <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Notes</Text>
            <Text className="text-sm text-un1t-text">{data.notes}</Text>
          </View>
        ) : null}

        {/* Revoke action — submitter only, submitted only */}
        {data.status === 'submitted' && isSubmitter && (
          <Pressable
            onPress={confirmRevoke}
            disabled={busy === 'revoke'}
            className="bg-red-500/15 border border-red-500/30 active:opacity-70 px-4 py-3 rounded-xl items-center flex-row justify-center"
          >
            {busy === 'revoke'
              ? <ActivityIndicator color="#DC2626" />
              : <Ionicons name="arrow-undo-outline" size={16} color="#DC2626" />}
            <Text className="text-sm font-semibold text-red-700 ml-2">Revoke this submission</Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  )
}

function Timeline({ data }) {
  const events = []
  if (data.submitted_at) events.push({ ts: data.submitted_at, label: 'Submitted', sub: data.submitter?.full_name ? `by ${data.submitter.full_name}` : null, tone: 'amber' })
  if (data.revoked_at) events.push({ ts: data.revoked_at, label: 'Revoked', sub: 'Submission pulled back. You can submit a fresh one.', tone: 'slate' })
  if (data.declined_at) {
    events.push({ ts: data.declined_at, label: 'Declined', sub: data.reviewer?.full_name ? `by ${data.reviewer.full_name}` : null, tone: 'red' })
  }
  if (data.approved_at) {
    events.push({ ts: data.approved_at, label: 'Approved', sub: data.reviewer?.full_name ? `by ${data.reviewer.full_name}` : null, tone: 'green' })
  }
  events.sort((a, b) => new Date(a.ts) - new Date(b.ts))

  if (events.length === 0) {
    return <Text className="text-sm text-un1t-subtle">No events yet.</Text>
  }

  return (
    <View className="space-y-3">
      {events.map((e, i) => (
        <View key={i} className="flex-row gap-3">
          <View className={`w-2 h-2 rounded-full mt-2 ${dotColor(e.tone)}`} />
          <View className="flex-1">
            <Text className="text-sm font-medium text-un1t-text">{e.label}</Text>
            {e.sub ? <Text className="text-xs text-un1t-subtle mt-0.5">{e.sub}</Text> : null}
            <Text className="text-[11px] text-un1t-subtle mt-0.5">{formatTs(e.ts)}</Text>
          </View>
        </View>
      ))}
    </View>
  )
}

function dotColor(tone) {
  if (tone === 'green') return 'bg-green-500'
  if (tone === 'red') return 'bg-red-500'
  if (tone === 'amber') return 'bg-amber-500'
  return 'bg-slate-400'
}
function formatTs(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
