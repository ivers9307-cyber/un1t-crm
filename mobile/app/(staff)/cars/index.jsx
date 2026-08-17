// W2 — Cars list (CCF Autos Tesla import tracker), read-only. Scoped to
// the active studio (the car_processing feature gate means the tile only
// shows at the CCF location). Tabs by status; tap a car for the detail.
// Gated by canMobile(car_processing); /api/cars re-checks server-side.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listCars, carTitle, carReg, carMoney, CAR_STATUS_STYLE } from '../../../lib/cars-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const TABS = [
  { key: null, label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
]

export default function CarsList() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'car_processing', activeLocation)

  const [cars, setCars] = useState([])
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const res = await listCars({ locationId: activeLocation?.id, status })
    if (res.success === false) { setError(res.error || 'Failed to load'); setCars([]); return }
    setError(null)
    setCars(Array.isArray(res.data) ? res.data : [])
  }, [activeLocation?.id, status])

  // Reload on focus + on status-filter change (load closes over status).
  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canView, load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Cars', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Car processing isn’t enabled for you at {activeLocation?.name || 'this studio'}.</Text>
        </View>
      ) : (
        <>
          <View className="flex-row gap-2 px-4 pt-3 pb-2">
            {TABS.map(t => {
              const active = status === t.key
              return (
                <Pressable
                  key={t.key || 'all'}
                  onPress={() => { if (status !== t.key) { setStatus(t.key); setLoading(true) } }}
                  className={`px-3 py-1.5 rounded-full border ${active ? 'bg-un1t-text border-un1t-text' : 'bg-un1t-surface border-un1t-border'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text className={`text-xs font-medium ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>{t.label}</Text>
                </Pressable>
              )
            })}
          </View>

          <ScrollView
            contentContainerClassName="px-4 pb-10"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
          >
            {error && (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                <Text className="text-red-500 text-sm">{error}</Text>
              </View>
            )}

            {loading ? (
              <View className="py-12 items-center"><ActivityIndicator /></View>
            ) : cars.length === 0 ? (
              <View className="py-16 items-center px-6">
                <Ionicons name="car-sport-outline" size={30} color="#94A3B8" />
                <Text className="text-base font-semibold text-un1t-text mt-3">No cars</Text>
                <Text className="text-xs text-un1t-subtle text-center mt-1">Imports at {activeLocation?.name || 'this studio'} show up here.</Text>
              </View>
            ) : (
              cars.map(car => {
                const st = CAR_STATUS_STYLE[car.status] || CAR_STATUS_STYLE.pending
                const price = carMoney(car.irish_sale_price_inc_vat)
                return (
                  <Pressable
                    key={car.id}
                    onPress={() => router.push(`/cars/${car.id}`)}
                    className="bg-white border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
                  >
                    <View className="flex-row items-center justify-between mb-1">
                      <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>{carTitle(car)}</Text>
                      {price ? <Text className="text-base font-semibold text-un1t-text ml-2">{price}</Text> : null}
                    </View>
                    <View className="flex-row items-center justify-between">
                      <Text className="text-xs text-un1t-subtle">{carReg(car)}</Text>
                      <View className={`px-2 py-0.5 rounded-full ${st.bg}`}>
                        <Text className={`text-[11px] uppercase font-medium ${st.text}`}>{st.label}</Text>
                      </View>
                    </View>
                  </Pressable>
                )
              })
            )}
          </ScrollView>
        </>
      )}
    </View>
  )
}
