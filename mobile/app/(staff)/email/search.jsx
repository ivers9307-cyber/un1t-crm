// Mail search — the full-screen query surface (MOBILE-MAIL-SEARCH.1,
// mockup §03). Pushed from the inbox's search field; the whole screen IS the
// query: autofocused field + Cancel up top, dense MailRow results below, the
// scope stated in words between them.
//
// THIN BY CONTRACT. Every branchable decision — the 300ms debounce, which
// response may land, what a failure reads as, the scope-line copy, which
// characters of a subject get the ink mark — lives in lib/mail-search.js,
// where vitest + mutation testing can reach it (mobile screens have no render
// harness). This file owns a TextInput, a FlatList, and the wiring.
//
// SCOPE: listMail is called with { q } and NO view param, which makes the
// route scan every view at once — a folder is not a filing cabinet, so
// archived answers surface too, wearing their Archived chip (MailRow renders
// it off row.status; nothing here has to ask). searchPartial arrives when the
// server truncated its scan, and the scope line says so instead of pretending
// completeness.
//
// THE ERROR STATE IS NOT AN EMPTY STATE (mockup §06, the house rule): a
// failed search keeps whatever results were already showing, paints the
// failure as a failure, and offers a retry. "No mail matches" renders only
// when the server actually answered.

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View, Text, TextInput, FlatList, Pressable, ActivityIndicator,
} from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listMail } from '../../../lib/email-api'
import MailRow from '../../../components/MailRow'
import {
  initialSearchState, createMailSearchController,
  searchScopeLine, noMatchesCopy, SEARCH_ERROR_COPY,
} from '../../../lib/mail-search'

export default function MailSearch() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  // The raw text is the input's own; the controller trims/debounces its copy.
  const [text, setText] = useState('')
  const [state, setState] = useState(initialSearchState())
  const controllerRef = useRef(null)

  // Same re-check as the Mail tab: this route is only pushed from a gated
  // screen, but a stale deep link must read as "not enabled", not as a
  // search box where every request 403s.
  const canEmail = canMobile(profile, 'email_inbox', activeLocation)
  const locationId = activeLocation?.id

  useEffect(() => {
    if (!locationId || !canEmail) return undefined
    const controller = createMailSearchController({
      search: (q) => listMail(locationId, { q }),
      onState: setState,
    })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [locationId, canEmail])

  const onChangeText = useCallback((t) => {
    setText(t)
    controllerRef.current?.setQuery(t)
  }, [])

  // The keyboard's Search key skips whatever is left of the debounce.
  const onSubmit = useCallback(() => {
    controllerRef.current?.retry()
  }, [])

  const scopeLine = searchScopeLine(state)
  const showEmpty = state.phase === 'results' && state.rows.length === 0
  const empty = showEmpty ? noMatchesCopy(state.query) : null

  return (
    <SafeAreaView className="flex-1 bg-un1t-bg" edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* The query bar — active field + Cancel, over a hairline. */}
      <View className="flex-row items-center px-4 pb-2.5 pt-1 border-b border-un1t-border bg-un1t-surface">
        <View className="flex-1 h-9 flex-row items-center rounded-lg border-[1.5px] border-un1t-text bg-un1t-surface px-2.5">
          <Ionicons name="search" size={14} color="#111827" style={{ marginRight: 6 }} />
          <TextInput
            className="flex-1 text-[15px] font-semibold text-un1t-text py-0"
            value={text}
            onChangeText={onChangeText}
            onSubmitEditing={onSubmit}
            placeholder="Search mail"
            placeholderTextColor="#94A3B8"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            accessibilityLabel="Search mail"
          />
        </View>
        <Pressable onPress={() => router.back()} hitSlop={8} className="ml-3 active:opacity-60">
          <Text className="text-[13px] font-bold text-un1t-subtle">Cancel</Text>
        </Pressable>
      </View>

      {!canEmail ? (
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="mail-outline" size={32} color="#94A3B8" />
          <Text className="text-sm text-un1t-subtle mt-2 text-center">
            Mail isn’t enabled for you at this location.
          </Text>
        </View>
      ) : (
        <>
          {/* The scope, stated — "4 conversations · all views", and the
              truncation admission when the scan was partial. */}
          {scopeLine ? (
            <Text
              className="px-4 pt-2.5 pb-1 text-[10px] font-bold text-un1t-subtle uppercase"
              style={{ letterSpacing: 1 }}
            >
              {scopeLine}
            </Text>
          ) : null}

          {/* A failure is a failure — never an empty state. Results already
              on screen stay listed underneath the banner. */}
          {state.phase === 'error' ? (
            <View className="mx-4 mt-3 rounded-xl bg-red-500/10 border border-red-500/30 p-3">
              <Text className="text-sm font-semibold text-red-700">{SEARCH_ERROR_COPY.title}</Text>
              <Text className="text-xs text-red-700 mt-0.5">{SEARCH_ERROR_COPY.body}</Text>
              <Pressable
                onPress={() => controllerRef.current?.retry()}
                hitSlop={6}
                className="mt-2 self-start active:opacity-60"
              >
                <Text className="text-xs font-bold text-red-700 underline">
                  {SEARCH_ERROR_COPY.retry}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {state.phase === 'idle' ? (
            <View className="items-center px-10 pt-16">
              <Ionicons name="search-outline" size={28} color="#94A3B8" />
              <Text className="text-sm text-un1t-subtle mt-2 text-center">
                Names, subjects, anything said — across every view, archived included.
              </Text>
            </View>
          ) : state.phase === 'searching' && state.rows.length === 0 ? (
            <View className="items-center pt-16">
              <ActivityIndicator />
            </View>
          ) : showEmpty ? (
            <View className="items-center px-10 pt-16">
              <Ionicons name="mail-open-outline" size={28} color="#94A3B8" />
              <Text className="text-base font-semibold text-un1t-text mt-2 text-center">
                {empty.title}
              </Text>
              <Text className="text-sm text-un1t-subtle mt-1 text-center">
                {empty.body}
              </Text>
            </View>
          ) : (
            <FlatList
              data={state.rows}
              keyExtractor={(row) => String(row.id)}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerClassName="pb-16"
              renderItem={({ item }) => (
                // Bare MailRow — no swipe wrapper here (gestures belong to the
                // inbox); a search result opens the thread exactly like an
                // inbox row. `highlight` carries the query for the subject's
                // ink marks (splitHighlight in lib/mail-search.js).
                <MailRow
                  row={item}
                  highlight={state.query}
                  onPress={() => router.push(`/email/${item.id}`)}
                />
              )}
            />
          )}
        </>
      )}
    </SafeAreaView>
  )
}
