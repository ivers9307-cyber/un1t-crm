// Invoice detail — status, audit timeline, View PDF (opens in
// external browser via expo-web-browser), Revoke button when
// applicable. Resubmission goes through the standard /invoices/new
// route.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  Alert, RefreshControl,
} from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as WebBrowser from 'expo-web-browser'
import { getInvoice, getInvoicePdfUrl, revokeInvoice, periodLabel } from '../../lib/invoices-api'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const STATUS_STYLE = {
  submitted: { label: 'Awaiting review', tint: '#D97706', bg: 'bg-amber-500/20', text: 'text-amber-700', icon: 'time-outline' },
  approved:  { label: 'Approved',        tint: '#059669', bg: 'bg-green-500/20', text: 'text-green-700', icon: 'checkmark-circle-outline' },
  declined:  { label: 'Declined',        tint: '#DC2626', bg: 'bg-red-500/20',   text: 'text-red-700',   icon: 'close-circle-outline' },
  revoked:   { label: 'Revoked',         tint: '#64748B', bg: 'bg-slate-500/20', text: 'text-slate-700', icon: 'arrow-undo-outline' },
}

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [pdfLoading, setPdfLoading] = useState(false)

  const fetch = useCallback(async () => {
    setError(null)
    const r = await getInvoice(id)
    if (r.success === false) {
      setError(r.error || 'Failed to load')
    } else {
      setData(r.data)
    }
  }, [id])

  useEffect(() => {
    setLoading(true)
    fetch().finally(() => setLoading(false))
  }, [fetch])

  async function onRefresh() {
    setRefreshing(true)
    await fetch()
    setRefreshing(false)
  }

  async function handleViewPdf() {
    setPdfLoading(true)
    try {
      const r = await getInvoicePdfUrl(id)
      if (r.success && r.url) {
        await WebBrowser.openBrowserAsync(r.url)
      } else {
        Alert.alert('PDF unavailable', r.error || 'Unknown error')
      }
    } finally {
      setPdfLoading(false)
    }
  }

  function confirmRevoke() {
    Alert.alert(
      'Revoke this submission?',
      'It stays in your history (and the approver\'s audit trail) but is no longer in the review queue. You can submit a fresh invoice for the same month afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: doRevoke },
      ]
    )
  }

  async function doRevoke() {
    setBusy('revoke')
    const r = await revokeInvoice(id)
    setBusy(null)
    if (r.success) {
      await fetch()
    } else {
      Alert.alert('Revoke failed', r.error || 'Unknown error')
    }
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-black items-center justify-center">
        <ActivityIndicator color="#94A3B8" />
      </View>
    )
  }
  if (error || !data) {
    return (
      <View className="flex-1 bg-un1t-black items-center justify-center p-6">
        <Text className="text-sm text-red-700">{error || 'Not found'}</Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  const status = STATUS_STYLE[data.status] || STATUS_STYLE.submitted

  return (
    <>
      <Stack.Screen
        options={{
          title: periodLabel(data.period_start),
          // invoices/[id] is the only screen in its sub-stack and is
          // pushed from (tabs)/invoices — iOS won't auto-render a
          // back chevron across the navigator boundary. Opt in.
          headerLeft: () => <BackHeaderLeft label="Invoices" fallbackHref="/(tabs)/invoices" />,
        }}
      />
      <ScrollView
        className="flex-1 bg-un1t-black"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        {/* Header */}
        <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-5 mb-4">
          <Text className="text-xs uppercase font-semibold text-un1t-light mb-1">Period</Text>
          <Text className="text-xl font-bold text-un1t-white mb-3">{periodLabel(data.period_start)}</Text>

          <Text className="text-xs uppercase font-semibold text-un1t-light mb-1">Amount</Text>
          <Text className="text-2xl font-bold text-un1t-white mb-3">
            €{Number(data.invoice_amount).toFixed(2)}
          </Text>

          {data.invoice_number ? (
            <>
              <Text className="text-xs uppercase font-semibold text-un1t-light mb-1">Your reference</Text>
              <Text className="text-sm text-un1t-white mb-3">{data.invoice_number}</Text>
            </>
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
            <Text className="text-sm text-un1t-white">{data.decline_reason}</Text>
            <Pressable
              onPress={() => router.push({ pathname: '/invoices/new', params: { resubmitMonth: monthKeyFromPeriod(data.period_start) } })}
              className="mt-3 bg-blue-600 active:opacity-80 px-4 py-2.5 rounded-xl items-center"
            >
              <Text className="text-sm font-semibold text-white">Resubmit a corrected invoice</Text>
            </Pressable>
          </View>
        )}

        {/* PDF view */}
        <Pressable
          onPress={handleViewPdf}
          disabled={pdfLoading}
          className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-4 flex-row items-center active:opacity-70"
        >
          <View className="w-10 h-10 rounded-full bg-blue-500/20 items-center justify-center">
            {pdfLoading
              ? <ActivityIndicator color="#2563EB" />
              : <Ionicons name="document-text" size={20} color="#2563EB" />}
          </View>
          <View className="flex-1 ml-3">
            <Text className="text-sm font-semibold text-un1t-white">View PDF</Text>
            <Text className="text-xs text-un1t-light">Opens in your browser</Text>
          </View>
          <Ionicons name="open-outline" size={18} color="#64748B" />
        </Pressable>

        {/* Audit timeline */}
        <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-4">
          <Text className="text-xs uppercase font-semibold text-un1t-light mb-3">Audit trail</Text>
          <Timeline data={data} />
        </View>

        {data.notes ? (
          <View className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-4">
            <Text className="text-xs uppercase font-semibold text-un1t-light mb-1">Your notes</Text>
            <Text className="text-sm text-un1t-white">{data.notes}</Text>
          </View>
        ) : null}

        {/* Revoke action — contractor only, submitted only */}
        {data.status === 'submitted' && data.viewer_role === 'self' && (
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
  if (data.submitted_at) events.push({ ts: data.submitted_at, label: 'Submitted', tone: 'amber' })
  if (data.revoked_at) events.push({ ts: data.revoked_at, label: 'Revoked by you', sub: 'Submission pulled back. You can submit a fresh one for the same month.', tone: 'slate' })
  if (data.reviewed_at && data.status === 'declined') {
    events.push({ ts: data.reviewed_at, label: 'Declined', sub: data.reviewer?.full_name ? `by ${data.reviewer.full_name}` : null, tone: 'red' })
  }
  if (data.reviewed_at && data.status === 'approved') {
    events.push({ ts: data.reviewed_at, label: 'Approved', sub: data.reviewer?.full_name ? `by ${data.reviewer.full_name}` : null, tone: 'green' })
  }
  if (data.xero_synced_at) events.push({ ts: data.xero_synced_at, label: 'Forwarded to accounts', tone: 'green' })
  events.sort((a, b) => new Date(a.ts) - new Date(b.ts))

  return (
    <View className="space-y-3">
      {events.map((e, i) => (
        <View key={i} className="flex-row gap-3">
          <View className={`w-2 h-2 rounded-full mt-2 ${dotColor(e.tone)}`} />
          <View className="flex-1">
            <Text className="text-sm font-medium text-un1t-white">{e.label}</Text>
            {e.sub ? <Text className="text-xs text-un1t-light mt-0.5">{e.sub}</Text> : null}
            <Text className="text-[11px] text-un1t-light mt-0.5">{formatTs(e.ts)}</Text>
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
function monthKeyFromPeriod(periodStart) {
  return (periodStart || '').slice(0, 7)
}
