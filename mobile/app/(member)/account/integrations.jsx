// Integrations screen — mirrors src/app/account/integrations/{page,IntegrationsManager}.jsx.
//
// Data:
//   supabase.rpc('list_enabled_integrations')  — enabled providers from service_integrations
//   contact_external_integrations              — member's connected accounts (via RLS, mig 118)
//
// Mutations (mirror IntegrationsManager.jsx exactly):
//   UPDATE contact_external_integrations SET auto_export_enabled  (toggle)
//   UPDATE contact_external_integrations SET disconnected_at, auto_export_enabled=false  (disconnect)
//
// OAuth connect:
//   The web uses href={`/api/oauth/${provider}/start`} which kicks off a server-side
//   redirect flow at app.champfitness.ie. In RN there is no <a href>. We open the URL
//   with expo-linking (Linking.openURL) — the system browser handles the OAuth redirect
//   and the member is returned to the browser. This is the closest RN equivalent of
//   the web's native redirect; deep-link callback back into the app is not wired (the
//   web callback page doesn't redirect to un1tapp://).
//   NOTE: expo-web-browser is not installed (not in mobile/package.json). Linking.openURL
//   is already available via expo-linking which IS installed.

import { useState, useCallback } from 'react'
import {
  View, Text, Pressable, ScrollView, Switch, ActivityIndicator, Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as Linking from 'expo-linking'
import { supabase } from '../../../lib/member/supabase'
import { api } from '../../../lib/member/api'
import { useAuth } from '../../../lib/member/contact-context'
import Card from '../../../components/member/ui/Card'
// ── Provider metadata (mirrors PROVIDER_META in IntegrationsManager.jsx) ─────

const PROVIDER_META = {
  strava: {
    label: 'Strava',
    icon: 'pulse-outline',
    blurb: 'Auto-post each session as a Strava workout with the full HR graph.',
    comingSoon: false,
  },
  garmin: {
    label: 'Garmin Connect',
    icon: 'watch-outline',
    blurb: 'Sync sessions to Garmin Connect. Coming soon.',
    comingSoon: true,
  },
  fitbit: {
    label: 'Fitbit',
    icon: 'fitness-outline',
    blurb: 'Sync to Fitbit. Coming soon.',
    comingSoon: true,
  },
  whoop: {
    label: 'Whoop',
    icon: 'flash-outline',
    blurb: 'Sync to Whoop. Coming soon.',
    comingSoon: true,
  },
}

function shortDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function Integrations() {
  const router = useRouter()
  const { contact } = useAuth()

  const [providers, setProviders] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    if (!contact?.id) return
    setLoading(true)
    setError(null)
    try {
      const [{ data: pRows, error: pErr }, { data: cRows, error: cErr }] = await Promise.all([
        supabase.rpc('list_enabled_integrations'),
        supabase
          .from('contact_external_integrations')
          .select('id, provider, external_athlete_id, auto_export_enabled, connected_at, disconnected_at, last_export_at, last_error')
          .eq('contact_id', contact.id)
          .is('disconnected_at', null),
      ])
      if (pErr) throw pErr
      if (cErr) throw cErr
      setProviders(pRows || [])
      setRows(cRows || [])
    } catch (e) {
      setError(e?.message || 'Failed to load integrations')
    } finally {
      setLoading(false)
    }
  }, [contact?.id])

  useFocusEffect(
    useCallback(() => { load() }, [load])
  )

  // Toggle auto-export (mirrors setAutoExport in IntegrationsManager.jsx)
  async function setAutoExport(row, value) {
    setError(null)
    setBusyId(row.id)
    const { error: e } = await supabase
      .from('contact_external_integrations')
      .update({ auto_export_enabled: value })
      .eq('id', row.id)
    setBusyId(null)
    if (e) { setError(e.message); return }
    setRows((rs) => rs.map((r) => r.id === row.id ? { ...r, auto_export_enabled: value } : r))
  }

  // Disconnect (mirrors disconnect in IntegrationsManager.jsx)
  function disconnect(row) {
    const meta = PROVIDER_META[row.provider]
    const label = meta?.label || row.provider
    Alert.alert(
      `Disconnect ${label}?`,
      'You can reconnect any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setError(null)
            setBusyId(row.id)
            const { error: e } = await supabase
              .from('contact_external_integrations')
              .update({ disconnected_at: new Date().toISOString(), auto_export_enabled: false })
              .eq('id', row.id)
            setBusyId(null)
            if (e) { setError(e.message); return }
            setRows((rs) => rs.filter((r) => r.id !== row.id))
          },
        },
      ]
    )
  }

  // Initiate OAuth via an authed JSON call so the server knows who we are
  // (native browser carries no Supabase cookie). The server returns a
  // signed authorize URL we open in the system browser; Strava redirects
  // back to un1tapp:// which brings the user back to this screen.
  async function connectProvider(provider) {
    setError(null)
    const r = await api('/api/oauth/' + provider + '/start?mode=json')
    if (r?.success === false || !r?.url) {
      setError("Couldn't start the connection. Please try again.")
      return
    }
    await Linking.openURL(r.url)
  }

  const enabledProviderSlugs = new Set(providers.map((p) => p.provider))

  return (
    <SafeAreaView className="flex-1 bg-iron-bg" edges={['left', 'right']}>
      <ScrollView contentContainerClassName="p-5 pb-24">

        {/* Back */}
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-1 mb-4 self-start active:opacity-60"
        >
          <Ionicons name="chevron-back-outline" size={18} color="#B3B2AC" />
          <Text className="text-sm text-chalk-2">Back</Text>
        </Pressable>

        {/* Header */}
        <Text className="text-2xl font-display-bold text-chalk">Integrations</Text>
        <Text className="mt-1 text-sm text-chalk-2">
          Send your sessions to the apps you already use.
        </Text>

        {/* Error banner */}
        {error ? (
          <View className="mt-4 rounded-xl border border-red-900 bg-red-950 p-3">
            <Text className="text-sm text-red-200">{error}</Text>
          </View>
        ) : null}

        {/* Apple Health — native HealthKit device flow, NOT the OAuth provider list.
            Routes to its own screen (Open Wearables SDK + /api/wearables/connect). */}
        <Pressable
          onPress={() => router.push('/account/connect-apple-health')}
          className="mt-6 flex-row items-center gap-3 rounded-[20px] border border-iron-hairline bg-iron-surface p-5 active:bg-iron-raised"
        >
          <View className="h-9 w-9 rounded-full bg-iron-raised items-center justify-center shrink-0">
            <Ionicons name="heart-outline" size={18} color="#FF4E42" />
          </View>
          <View className="flex-1 min-w-0">
            <Text className="text-base font-display text-chalk">Apple Health</Text>
            <Text className="mt-0.5 text-xs text-chalk-2">Sync your Apple Watch workouts</Text>
          </View>
          <Ionicons name="chevron-forward-outline" size={18} color="#B3B2AC" />
        </Pressable>

        {loading ? (
          <View className="mt-12 items-center">
            <ActivityIndicator color="#F1EEE7" size="large" />
          </View>
        ) : (
          <View className="mt-6 gap-3">
            {/* Empty state (mirrors IntegrationsManager when providers=[] AND rows=[]) */}
            {providers.length === 0 && rows.length === 0 && (
              <Card>
                <Text className="text-sm text-chalk-2 text-center">
                  No integrations available yet. Your studio will turn these on once they've set them up.
                </Text>
              </Card>
            )}

            {/* Enabled providers */}
            {providers.map((p) => {
              const row = rows.find((r) => r.provider === p.provider) || null
              const meta = PROVIDER_META[p.provider] || {
                label: p.display_name || p.provider,
                icon: 'flash-outline',
                blurb: '',
                comingSoon: false,
              }
              const isBusy = busyId === row?.id

              return (
                <View
                  key={p.provider}
                  className="rounded-[20px] border border-iron-hairline bg-iron-surface p-5"
                >
                  <View className="flex-row items-start gap-3">
                    <View className="h-9 w-9 rounded-full bg-iron-raised items-center justify-center shrink-0">
                      <Ionicons name={meta.icon} size={18} color="#B3B2AC" />
                    </View>
                    <View className="flex-1 min-w-0">
                      <Text className="text-base font-display text-chalk">
                        {p.display_name || meta.label}
                      </Text>
                      {meta.blurb ? (
                        <Text className="mt-1 text-xs text-chalk-2">{meta.blurb}</Text>
                      ) : null}
                      {row?.last_export_at ? (
                        <View className="mt-2 flex-row items-center gap-1">
                          <Ionicons name="checkmark-circle-outline" size={12} color="#34D399" />
                          <Text className="text-[11px] text-emerald-400">
                            Last exported {shortDate(row.last_export_at)}
                          </Text>
                        </View>
                      ) : null}
                      {row?.last_error ? (
                        <View className="mt-1 flex-row items-center gap-1">
                          <Ionicons name="alert-circle-outline" size={12} color="#FF4E42" />
                          <Text className="text-[11px] text-red-400" numberOfLines={2}>
                            Last error: {row.last_error}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    {/* Connect button (only when not yet connected) */}
                    {!row && !meta.comingSoon && (
                      <Pressable
                        onPress={() => connectProvider(p.provider)}
                        className="flex-row items-center gap-1 rounded-xl bg-chalk px-3 py-2 shrink-0 active:opacity-80"
                      >
                        <Ionicons name="open-outline" size={14} color="#131316" />
                        <Text className="text-sm font-body-semibold text-iron-bg">Connect</Text>
                      </Pressable>
                    )}
                    {!row && meta.comingSoon && (
                      <View className="rounded-full border border-iron-hairline px-2.5 py-0.5">
                        <Text className="font-mono text-[10px] uppercase text-chalk-3" style={{ letterSpacing: 1.2 }}>Soon</Text>
                      </View>
                    )}
                  </View>

                  {/* Connected controls: auto-export toggle + disconnect */}
                  {row && (
                    <View className="mt-4 pt-4 border-t border-iron-hairline flex-row flex-wrap items-center gap-3">
                      <View className="flex-row items-center gap-2 flex-1">
                        <Switch
                          value={row.auto_export_enabled}
                          disabled={isBusy}
                          onValueChange={(v) => setAutoExport(row, v)}
                          trackColor={{ false: '#2A2A31', true: '#F1EEE7' }}
                          thumbColor={row.auto_export_enabled ? '#131316' : '#B3B2AC'}
                        />
                        <Text className="text-sm text-chalk">Auto-export each session</Text>
                      </View>
                      <Pressable
                        onPress={() => disconnect(row)}
                        disabled={isBusy}
                        className="flex-row items-center gap-1 rounded-xl border border-iron-hairline px-3 py-1.5 active:bg-iron-raised disabled:opacity-50"
                      >
                        {isBusy
                          ? <ActivityIndicator size="small" color="#FF4E42" />
                          : <Ionicons name="power-outline" size={12} color="#FF4E42" />}
                        <Text className="text-xs font-body-medium" style={{ color: '#FF4E42' }}>Disconnect</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              )
            })}

            {/* Tokens for providers that are no longer enabled — still render so
                member can disconnect cleanly (mirrors IntegrationsManager.jsx) */}
            {rows.filter((r) => !enabledProviderSlugs.has(r.provider)).map((row) => (
              <View key={row.id} className="rounded-[20px] border border-iron-hairline bg-iron-surface p-5">
                <Text className="text-sm font-body-semibold text-chalk">{row.provider}</Text>
                <Text className="mt-1 text-xs text-chalk-2">Provider currently disabled by your studio.</Text>
                <Pressable
                  onPress={() => disconnect(row)}
                  className="mt-3"
                >
                  <Text className="text-xs font-body-medium underline" style={{ color: '#FF4E42' }}>Disconnect</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
