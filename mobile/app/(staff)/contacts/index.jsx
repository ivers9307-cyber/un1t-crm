// W1 — contacts search + directory (read). Gated by canMobile(contacts).
// Type to search the member directory (name / phone / email); an empty
// query shows the most-recent contacts. Tap a row to open the detail.
import { useState, useCallback, useEffect } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, ActivityIndicator } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { searchContacts, prettyStage, contactDisplayName } from '../../../lib/contacts-api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function ContactsIndex() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'contacts', activeLocation)

  const [query, setQuery] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const run = useCallback(async (q) => {
    if (!activeLocation?.id) return
    setError(null)
    const res = await searchContacts({ locationId: activeLocation.id, query: q })
    if (!res.success) { setError(res.error || 'Search failed'); setRows([]); return }
    setRows(res.data)
  }, [activeLocation?.id])

  // Debounce search as the operator types (empty query → recent contacts).
  useEffect(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    const t = setTimeout(() => { run(query).finally(() => setLoading(false)) }, 280)
    return () => clearTimeout(t)
  }, [query, canView, run])

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Contacts', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Contacts isn’t enabled for your account here.</Text>
        </View>
      ) : (
        <>
          <View className="px-4 pt-3 pb-2">
            <View className="flex-row items-center rounded-xl border border-un1t-border bg-white px-3">
              <Ionicons name="search" size={16} color="#94A3B8" />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search name, phone or email"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                className="flex-1 py-2.5 px-2 text-un1t-text"
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
                  <Ionicons name="close-circle" size={16} color="#94A3B8" />
                </Pressable>
              )}
            </View>
          </View>

          <ScrollView contentContainerClassName="px-4 pb-10" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {error && (
              <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
                <Text className="text-red-500 text-sm">{error}</Text>
              </View>
            )}

            {loading ? (
              <View className="py-10 items-center"><ActivityIndicator /></View>
            ) : rows.length === 0 ? (
              <Text className="text-center text-un1t-subtle py-10 px-6 text-sm">
                {query.trim() ? 'No matching contacts.' : 'No contacts at this studio yet.'}
              </Text>
            ) : (
              <>
                {!query.trim() && (
                  <Text className="text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Recent</Text>
                )}
                {rows.map(c => (
                  <Pressable
                    key={c.id}
                    onPress={() => router.push(`/contacts/${c.id}`)}
                    className="rounded-2xl border border-un1t-border bg-white px-4 py-3 mb-2 active:bg-un1t-surface"
                  >
                    <Text className="text-base font-semibold text-un1t-text" numberOfLines={1}>{contactDisplayName(c)}</Text>
                    {(c.phone || c.pipeline_stage_slug) && (
                      <Text className="text-xs text-un1t-subtle mt-0.5" numberOfLines={1}>
                        {[c.phone, prettyStage(c.pipeline_stage_slug)].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
        </>
      )}
    </View>
  )
}
