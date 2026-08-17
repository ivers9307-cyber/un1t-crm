// W2 — Car detail (read-only). Mirrors the web CarDetail's read surface:
// vehicle, pricing, buyer (tap-to-call/email), deposit, Xero, documents,
// notes. The heavy actions (issue deposit link, Xero push, document
// upload, status changes, delete) stay on the web Cars page.
import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Linking,
} from 'react-native'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as WebBrowser from 'expo-web-browser'
import { useAuth } from '../../../lib/auth-context'
import { getCar, carTitle, carReg, carMoney, carDateLabel, CAR_STATUS_STYLE } from '../../../lib/cars-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

function Row({ label, value }) {
  if (value == null || value === '') return null
  return (
    <View className="mb-2.5">
      <Text className="text-[11px] uppercase font-semibold text-un1t-subtle mb-0.5">{label}</Text>
      <Text className="text-sm text-un1t-text">{value}</Text>
    </View>
  )
}

function Section({ title, children }) {
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-3">
      <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-3">{title}</Text>
      {children}
    </View>
  )
}

function ContactAction({ icon, label, value, onPress }) {
  if (!value) return null
  return (
    <Pressable onPress={onPress} className="flex-row items-center py-2 active:opacity-60">
      <View className="w-9 h-9 rounded-full bg-blue-500/15 items-center justify-center">
        <Ionicons name={icon} size={17} color="#2563EB" />
      </View>
      <View className="ml-3 flex-1">
        <Text className="text-[11px] uppercase font-semibold text-un1t-subtle">{label}</Text>
        <Text className="text-sm text-un1t-text">{value}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
    </Pressable>
  )
}

export default function CarDetailScreen() {
  const { id } = useLocalSearchParams()
  const { activeLocation } = useAuth()
  const router = useRouter()

  const [car, setCar] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const res = await getCar(id, { locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); return }
    setError(null)
    setCar(res.data)
  }, [id, activeLocation?.id])

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)) }, [load])
  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  if (loading) {
    return <View className="flex-1 bg-un1t-bg items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
  }
  if (error || !car) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Stack.Screen options={{ title: 'Car', headerLeft: () => <BackHeaderLeft label="Cars" fallbackHref="/cars" /> }} />
        <Text className="text-sm text-red-700">{error || 'Not found'}</Text>
        <Pressable onPress={() => router.back()} className="mt-4"><Text className="text-sm text-blue-600">Back</Text></Pressable>
      </View>
    )
  }

  const st = CAR_STATUS_STYLE[car.status] || CAR_STATUS_STYLE.pending
  const docs = Array.isArray(car.car_documents) ? car.car_documents : []
  const hasPricing = [car.uk_purchase_price_ex_vat, car.uk_vat, car.irish_sale_price_inc_vat, car.irish_sale_price_ex_vat].some(v => v != null)
  const hasDeposit = car.deposit_status || car.deposit_amount != null || car.deposit_paid_at

  return (
    <>
      <Stack.Screen options={{ title: carTitle(car), headerLeft: () => <BackHeaderLeft label="Cars" fallbackHref="/cars" /> }} />
      <ScrollView
        className="flex-1 bg-un1t-bg"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
      >
        {/* Header */}
        <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5 mb-3">
          <Text className="text-xl font-bold text-un1t-text">{carTitle(car)}</Text>
          <Text className="text-sm text-un1t-subtle mt-0.5">{carReg(car)}</Text>
          <View className={`px-2 py-1 rounded-full self-start mt-3 ${st.bg}`}>
            <Text className={`text-[11px] uppercase font-medium ${st.text}`}>{st.label}</Text>
          </View>
        </View>

        {/* Vehicle */}
        <Section title="Vehicle">
          <Row label="Make" value={car.make} />
          <Row label="Model" value={car.model} />
          <Row label="Year" value={car.vehicle_year ? String(car.vehicle_year) : null} />
          <Row label="VIN" value={car.vin} />
          <Row label="UK reg" value={car.uk_reg} />
          <Row label="Irish reg" value={car.irish_reg} />
        </Section>

        {/* Pricing */}
        {hasPricing && (
          <Section title="Pricing">
            <Row label="UK purchase (ex VAT)" value={carMoney(car.uk_purchase_price_ex_vat)} />
            <Row label="UK VAT" value={carMoney(car.uk_vat)} />
            <Row label="Irish sale (inc VAT)" value={carMoney(car.irish_sale_price_inc_vat)} />
            <Row label="Irish sale (ex VAT)" value={carMoney(car.irish_sale_price_ex_vat)} />
          </Section>
        )}

        {/* Buyer */}
        {(car.buyer_name || car.buyer_phone || car.buyer_email) && (
          <Section title="Buyer">
            <Row label="Name" value={car.buyer_name} />
            <ContactAction icon="call-outline" label="Phone" value={car.buyer_phone} onPress={() => Linking.openURL(`tel:${car.buyer_phone}`)} />
            <ContactAction icon="mail-outline" label="Email" value={car.buyer_email} onPress={() => Linking.openURL(`mailto:${car.buyer_email}`)} />
            <Row label="Address" value={car.buyer_address} />
          </Section>
        )}

        {/* Deposit */}
        {hasDeposit && (
          <Section title="Deposit">
            <Row label="Status" value={car.deposit_status ? String(car.deposit_status).replace(/_/g, ' ') : null} />
            <Row label="Amount" value={carMoney(car.deposit_amount)} />
            <Row label="Paid" value={car.deposit_paid_at ? `${carMoney(car.deposit_paid_amount) || ''} ${carDateLabel(car.deposit_paid_at)}`.trim() : null} />
          </Section>
        )}

        {/* Xero invoice */}
        {(car.xero_invoice_number || car.xero_invoice_id) && (
          <Section title="Xero invoice">
            <Row label="Invoice number" value={car.xero_invoice_number} />
            <Row label="Issued" value={carDateLabel(car.xero_invoice_issued_at)} />
            {car.xero_invoice_url ? (
              <Pressable
                onPress={() => WebBrowser.openBrowserAsync(car.xero_invoice_url)}
                className="flex-row items-center mt-1 active:opacity-60"
              >
                <Ionicons name="open-outline" size={16} color="#2563EB" />
                <Text className="text-sm font-medium text-blue-600 ml-1.5">View invoice</Text>
              </Pressable>
            ) : null}
          </Section>
        )}

        {/* VAT refund */}
        {car.uk_vat_refund_received && (
          <Section title="UK VAT refund">
            <Row label="Received" value={car.uk_vat_refund_received_at ? carDateLabel(car.uk_vat_refund_received_at) : 'Yes'} />
          </Section>
        )}

        {/* Documents */}
        {docs.length > 0 && (
          <Section title={`Documents · ${docs.length}`}>
            {docs.map(d => (
              <View key={d.id} className="flex-row items-center py-1.5">
                <Ionicons name="document-text-outline" size={16} color="#64748B" />
                <View className="ml-2 flex-1">
                  <Text className="text-sm text-un1t-text" numberOfLines={1}>{d.filename || d.doc_type || 'Document'}</Text>
                  {d.doc_type && d.filename ? <Text className="text-[11px] text-un1t-subtle">{d.doc_type}</Text> : null}
                </View>
              </View>
            ))}
            <Text className="text-[11px] text-un1t-muted mt-2">Upload and forwarding happen on the web Cars page.</Text>
          </Section>
        )}

        {/* Notes */}
        {car.notes ? (
          <Section title="Notes">
            <Text className="text-sm text-un1t-text">{car.notes}</Text>
          </Section>
        ) : null}

        <Text className="text-[11px] text-un1t-muted text-center mt-1">
          Added {carDateLabel(car.created_at)}{car.completed_at ? ` · Completed ${carDateLabel(car.completed_at)}` : ''}
        </Text>
      </ScrollView>
    </>
  )
}
