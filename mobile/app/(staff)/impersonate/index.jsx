// Master-only "View as user" picker. Search-as-you-type list of every
// user in the system; tap one (with optional reason) to start an
// impersonation session. The auth-context's startImpersonation() takes
// care of writing the audit row, persisting the target locally, and
// re-fetching /me so the banner appears immediately on return.
//
// Routed from the More tab via router.push('/impersonate'). Auth gate
// happens here too — if a non-master somehow lands on this screen we
// bounce them back rather than rely on the route being hidden.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, TextInput, FlatList, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, Stack } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { api } from '../../../lib/api'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

export default function ImpersonatePicker() {
  const router = useRouter()
  const { profile, impersonatingFrom, startImpersonation } = useAuth()
  // Real master gate — visible role flips when impersonating, so allow
  // the screen if either the visible role is master OR an impersonation
  // is already active (caller is implicitly a master in that case).
  const isMaster = profile?.role === 'master' || profile?.isMaster || !!impersonatingFrom

  const [query, setQuery] = useState('')
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reason, setReason] = useState('')
  const [starting, setStarting] = useState(false)

  // Debounced server-side search. We could do client-side filtering on
  // a fixed initial list, but the route already supports ?q= and pages
  // 50-at-a-time, so let the server do the work. ~250ms of latency
  // between keystrokes is fine on a phone.
  useEffect(() => {
    let active = true
    const t = setTimeout(async () => {
      setLoading(true)
      setError(null)
      const path = query
        ? `/api/mobile/impersonate/users?q=${encodeURIComponent(query)}`
        : '/api/mobile/impersonate/users'
      const res = await api(path)
      if (!active) return
      if (res.success) {
        setUsers(res.users || [])
      } else {
        setError(res.error || 'Failed to load users')
      }
      setLoading(false)
    }, query ? 250 : 0)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [query])

  const handlePick = useCallback(async (target) => {
    if (starting) return
    setStarting(true)
    try {
      const res = await startImpersonation({
        targetUserId: target.id,
        reason: reason.trim() || null,
      })
      if (res.success) {
        // Pop back to More — the banner will be visible immediately.
        router.back()
      } else {
        Alert.alert('Could not start session', res.error || 'Try again.')
      }
    } finally {
      setStarting(false)
    }
  }, [starting, startImpersonation, reason, router])

  if (!isMaster) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center px-6">
        <Stack.Screen options={{ title: 'View as user', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />
        <Text className="text-base text-un1t-subtle text-center">
          Only master accounts can switch into another user's view.
        </Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: 'View as user', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />
      <View className="flex-1 bg-un1t-bg">
        {/* Search + reason field */}
        <View className="px-4 pt-3 pb-2 border-b border-un1t-border bg-un1t-surface">
          <View className="flex-row items-center bg-un1t-border rounded-lg px-3 py-2">
            <Ionicons name="search" size={16} color="#94A3B8" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search by name or email"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 ml-2 text-un1t-text"
              style={{ paddingVertical: 0 }}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} hitSlop={12}>
                <Ionicons name="close-circle" size={16} color="#94A3B8" />
              </Pressable>
            )}
          </View>

          <Text className="text-[10px] uppercase tracking-wider text-un1t-muted mt-3 mb-1">
            Reason (optional)
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Debugging Sara's missing schedule"
            placeholderTextColor="#94A3B8"
            className="bg-un1t-border rounded-lg px-3 py-2 text-un1t-text text-sm"
            maxLength={500}
          />
        </View>

        {/* Results */}
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : error ? (
          <View className="px-6 py-8 items-center">
            <Text className="text-sm text-red-400 text-center">{error}</Text>
          </View>
        ) : users.length === 0 ? (
          <View className="px-6 py-8 items-center">
            <Text className="text-sm text-un1t-subtle text-center">
              {query ? 'No matches' : 'No users to show'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={users}
            keyExtractor={u => u.id}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => handlePick(item)}
                disabled={starting}
                className="px-4 py-3 border-b border-un1t-border active:bg-un1t-border/40 flex-row items-center"
              >
                <View className="w-9 h-9 rounded-full bg-un1t-border items-center justify-center">
                  <Text className="text-un1t-text font-semibold text-sm">
                    {(item.full_name || item.email || '?').slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View className="flex-1 ml-3">
                  <View className="flex-row items-center">
                    <Text
                      className="text-base font-medium text-un1t-text"
                      numberOfLines={1}
                    >
                      {item.full_name || item.email}
                    </Text>
                    {!item.active && (
                      <View className="ml-2 px-1.5 py-0.5 rounded bg-red-500/20">
                        <Text className="text-[9px] uppercase text-red-400 font-semibold">
                          Inactive
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text className="text-xs text-un1t-subtle" numberOfLines={1}>
                    {item.email} · {item.role}
                    {item.locations.length > 0 && ` · ${item.locations.join(', ')}`}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
              </Pressable>
            )}
          />
        )}

        {starting && (
          <View className="absolute inset-0 bg-black/60 items-center justify-center">
            <ActivityIndicator color="#FFF" />
            <Text className="text-xs text-white mt-2">Switching view…</Text>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  )
}
