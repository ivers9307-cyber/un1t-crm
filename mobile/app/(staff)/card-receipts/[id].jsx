// SPEND.P3 (mobile) — company-card receipt detail.
//
// Read-only view of one of the caller's submissions: the details they
// gave (submitted date, card last-4, note, location), a status line, and
// a "View receipt" button (opens the signed URL in the external browser
// via expo-web-browser). There are NO approve / decline / revoke actions
// — once submitted, the bookkeeper reads the amount / merchant / date /
// VAT off the photo and files it to Xero downstream in /invoices.
//
// Uses BackHeaderLeft because this screen is pushed from the
// /card-receipts list across the tab→stack navigator boundary, so iOS
// won't auto-render a chevron.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  Alert, RefreshControl,
} from 'react-native'
import { useLocalSearchParams, useRouter, useFocusEffect, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as WebBrowser from 'expo-web-browser'
import {
  getCardReceipt, getCardReceiptUrl, formatSubmittedAt,
} from '../../../lib/card-receipts-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function CardReceiptDetailScreen() {
  const { id } = useLocalSearchParams()
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [receiptLoading, setReceiptLoading] = useState(false)

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

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Receipt',
          headerLeft: () => <BackHeaderLeft label="Card receipts" fallbackHref="/card-receipts" />,
        }}
      />
      <ScrollView
        className="flex-1 bg-un1t-bg"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        {/* Details */}
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-4">
          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Submitted</Text>
          <Text className="text-sm text-un1t-text mb-3">{formatSubmittedAt(data.submitted_at)}</Text>

          {data.card_last4 ? (
            <>
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Card</Text>
              <Text className="text-sm text-un1t-text mb-3">•••• {data.card_last4}</Text>
            </>
          ) : null}

          {data.notes ? (
            <>
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Note</Text>
              <Text className="text-sm text-un1t-text mb-3">{data.notes}</Text>
            </>
          ) : null}

          {data.location?.name ? (
            <>
              <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1">Studio</Text>
              <Text className="text-sm text-un1t-text">{data.location.name}</Text>
            </>
          ) : null}
        </View>

        {/* Status line */}
        <View className="bg-amber-500/10 border-l-4 border-amber-500 p-4 mb-4 rounded-r-2xl flex-row items-start">
          <Ionicons name="time-outline" size={16} color="#D97706" />
          <Text className="text-sm text-un1t-text ml-2 flex-1">
            With accounts — the bookkeeper will file it to Xero.
          </Text>
        </View>

        {/* Receipt view */}
        <Pressable
          onPress={handleViewReceipt}
          disabled={receiptLoading}
          className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 flex-row items-center active:opacity-70"
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
      </ScrollView>
    </>
  )
}
