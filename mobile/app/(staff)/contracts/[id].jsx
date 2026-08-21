// Contract detail + sign + decline. Mobile equivalent of the
// web /account/contracts/[id] page.
//
// On open, GETs the contract (server flips issued -> viewed
// automatically). Renders the frozen body_rendered as a long
// scrollable text block, then the dual-signature block. If
// status is issued/viewed, a sign sheet appears at the bottom
// with a typed-name field + decline option.

import { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native'
import Markdown from 'react-native-markdown-display'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { getContract, signContract, declineContract } from '../../../lib/contracts-api'

// CONTRACTS-MD.1 — markdown styles for the frozen body_rendered.
// Mirrors the web ContractBody component (src/components/ContractBody.jsx)
// so the document reads the same on web and mobile. react-native-markdown-display
// wraps markdown-it, which defaults to `html: false` — any raw HTML in a
// template body (e.g. a stray <script>) is rendered as inert literal text,
// never parsed or executed.
const BODY_FONT = Platform.OS === 'ios' ? 'Georgia' : 'serif'
const markdownStyles = {
  body: { fontSize: 15, lineHeight: 24, color: '#111827', fontFamily: BODY_FONT },
  heading1: { fontSize: 22, fontWeight: 'bold', marginTop: 16, marginBottom: 8, color: '#111827' },
  heading2: { fontSize: 19, fontWeight: 'bold', marginTop: 14, marginBottom: 6, color: '#111827' },
  heading3: { fontSize: 17, fontWeight: '600', marginTop: 12, marginBottom: 6, color: '#111827' },
  heading4: { fontSize: 16, fontWeight: '600', marginTop: 10, marginBottom: 4, color: '#111827' },
  heading5: { fontSize: 15, fontWeight: '600', marginTop: 8, marginBottom: 4, color: '#111827' },
  heading6: { fontSize: 15, fontWeight: '600', marginTop: 8, marginBottom: 4, color: '#111827' },
  paragraph: { marginTop: 0, marginBottom: 12 },
  strong: { fontWeight: 'bold' },
  em: { fontStyle: 'italic' },
  bullet_list: { marginBottom: 12 },
  ordered_list: { marginBottom: 12 },
  list_item: { marginBottom: 4 },
  hr: { backgroundColor: '#D1D5DB', height: 1, marginVertical: 16 },
  link: { textDecorationLine: 'underline', color: '#111827' },
  blockquote: {
    borderLeftWidth: 2, borderLeftColor: '#D1D5DB', paddingLeft: 12,
    fontStyle: 'italic', color: '#374151', marginBottom: 12,
  },
  code_inline: {
    backgroundColor: '#F3F4F6', paddingHorizontal: 4, borderRadius: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
}

const STATUS_LABEL = {
  issued:   'Awaiting your signature',
  viewed:   'Awaiting your signature',
  signed:   'Signed',
  declined: 'You declined this contract',
  revoked:  'Withdrawn',
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function ContractDetail() {
  const { id } = useLocalSearchParams()
  const { profile } = useAuth()
  const [contract, setContract] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [signature, setSignature] = useState('')
  const [busy, setBusy] = useState(false)
  const [showDecline, setShowDecline] = useState(false)
  const [declineReason, setDeclineReason] = useState('')

  const load = useCallback(async () => {
    setError(null)
    const res = await getContract(id)
    if (res.success) {
      setContract(res.data)
      // Pre-fill signature with the user's name as a starting point.
      // They can edit before submit.
      if (!signature && profile?.full_name) setSignature(profile.full_name)
    } else {
      setError(res.error || 'Failed to load')
    }
    setLoading(false)
  }, [id, profile?.full_name, signature])

  useEffect(() => {
    load()
  }, [load])

  async function handleSign() {
    if (!signature.trim()) {
      Alert.alert('Signature required', 'Type your full name to sign.')
      return
    }
    setBusy(true)
    const res = await signContract(id, signature.trim())
    setBusy(false)
    if (!res.success) {
      Alert.alert('Could not sign', res.error || 'Try again.')
      return
    }
    // Refresh — page now shows signed state.
    await load()
  }

  async function handleDecline() {
    if (!declineReason.trim()) {
      Alert.alert('Reason required', 'Tell us briefly why you\'re declining.')
      return
    }
    setBusy(true)
    const res = await declineContract(id, declineReason.trim())
    setBusy(false)
    if (!res.success) {
      Alert.alert('Could not decline', res.error || 'Try again.')
      return
    }
    setShowDecline(false)
    await load()
  }

  if (loading) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center">
        <ActivityIndicator />
      </View>
    )
  }

  if (error || !contract) {
    return (
      <View className="flex-1 bg-un1t-bg p-6">
        <View className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
          <Text className="text-sm font-semibold text-red-700">Couldn't load this contract</Text>
          <Text className="text-xs text-red-700 mt-1">{error || 'Not found'}</Text>
        </View>
      </View>
    )
  }

  const c = contract
  const pending = c.status === 'issued' || c.status === 'viewed'
  const signed = c.status === 'signed'
  const declined = c.status === 'declined'
  const revoked = c.status === 'revoked'

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView className="flex-1 bg-un1t-bg" contentContainerClassName="p-4 pb-32">
        {/* Status banner — quick read of where this contract is. */}
        <View className={`rounded-xl p-3 mb-4 ${
          signed   ? 'bg-emerald-500/10 border border-emerald-500/30' :
          declined ? 'bg-red-500/10 border border-red-500/30' :
          revoked  ? 'bg-gray-500/10 border border-gray-500/30' :
                     'bg-amber-500/10 border border-amber-500/30'
        }`}>
          <Text className={`text-sm font-semibold ${
            signed   ? 'text-emerald-700' :
            declined ? 'text-red-700' :
            revoked  ? 'text-un1t-subtle' :
                       'text-amber-700'
          }`}>
            {STATUS_LABEL[c.status] || c.status}
          </Text>
          {c.template?.name && (
            <Text className="text-xs text-un1t-subtle mt-0.5">
              {c.template.name}
            </Text>
          )}
          {c.declined_reason && (
            <Text className="text-xs text-red-700 mt-2">{c.declined_reason}</Text>
          )}
          {c.revoked_reason && (
            <Text className="text-xs text-un1t-subtle mt-2">{c.revoked_reason}</Text>
          )}
        </View>

        {/* Body — frozen at issue time. Rendered as real markdown
            (headings, lists, emphasis, rules) in a white "paper"
            panel so it visually feels like a document on top of
            the dark app, and so recipients don't sign something
            showing literal `#`/`**`/`---`. */}
        <View className="bg-white rounded-xl p-4 mb-4">
          <Markdown style={markdownStyles}>{c.body_rendered || ''}</Markdown>

          {/* Dual-signature block */}
          <View className="mt-8 pt-4 border-t border-gray-300">
            {/* LEGALENT.1 — the contracting company comes from the API
                (GET /api/contracts/[id] reads the contract's own FROZEN
                variables_data.legal_entity_name, so this screen shows
                exactly what the web pages and the stored PDF show, for
                the life of the document). An older API build omits the
                field; render the block without a company claim rather
                than a wrong one. */}
            <Text className="text-[10px] uppercase tracking-wider text-gray-500">
              {c.contracting_entity ? `For ${c.contracting_entity}` : 'Countersigned'}
            </Text>
            <Text className="mt-2 text-2xl italic text-gray-900" style={{ fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' }}>
              {c.issuer_signature}
            </Text>
            <Text className="text-[10px] text-gray-500 mt-1">
              Signed {fmtDate(c.issued_at)}
            </Text>
          </View>

          <View className="mt-6">
            <Text className="text-[10px] uppercase tracking-wider text-gray-500">Employee / Contractor</Text>
            {signed ? (
              <>
                <Text className="mt-2 text-2xl italic text-gray-900" style={{ fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' }}>
                  {c.signature_value}
                </Text>
                <Text className="text-[10px] text-gray-500 mt-1">
                  Signed {fmtDate(c.signed_at)}
                  {c.signed_ip ? ` · ${c.signed_ip}` : ''}
                </Text>
              </>
            ) : (
              <Text className="mt-2 italic text-gray-400 text-sm">
                {pending ? 'Awaiting your signature below' : '—'}
              </Text>
            )}
          </View>
        </View>

        {/* Sign sheet — only when pending */}
        {pending && !showDecline && (
          <View className="bg-un1t-surface border border-un1t-border rounded-xl p-4">
            <Text className="text-sm font-semibold text-un1t-text">Your signature</Text>
            <Text className="text-xs text-un1t-subtle mt-1 mb-3">
              Type your full name as it appears on the contract. By signing, you agree to the terms above.
            </Text>
            <TextInput
              value={signature}
              onChangeText={setSignature}
              placeholder="Your full name"
              placeholderTextColor="#94A3B8"
              autoCapitalize="words"
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-3 text-un1t-text"
              style={{ fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', fontStyle: 'italic', fontSize: 18 }}
            />
            <Text className="text-[10px] text-un1t-muted mt-2">
              We record your IP, browser, and time of signing for legal verification (eIDAS Article 25).
            </Text>
            <View className="flex-row items-center justify-end gap-2 mt-4">
              <Pressable
                onPress={() => setShowDecline(true)}
                className="px-3 py-2 rounded-md border border-red-500/40 active:bg-red-500/10"
              >
                <Text className="text-xs text-red-700">Decline</Text>
              </Pressable>
              <Pressable
                onPress={handleSign}
                disabled={busy || !signature.trim()}
                className={`px-4 py-2 rounded-md flex-row items-center gap-1.5 ${
                  busy || !signature.trim() ? 'bg-un1t-border' : 'bg-un1t-text active:opacity-80'
                }`}
              >
                <Ionicons name="checkmark" size={14} color="#111827" />
                <Text className="text-xs font-semibold text-un1t-bg">
                  {busy ? 'Signing…' : 'Sign contract'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Decline sheet */}
        {showDecline && (
          <View className="bg-red-500/5 border border-red-500/30 rounded-xl p-4">
            <Text className="text-sm font-semibold text-red-700 mb-1">Decline this contract</Text>
            <Text className="text-xs text-un1t-subtle mb-3">
              UN1T Dublin will be notified by email.
            </Text>
            <TextInput
              value={declineReason}
              onChangeText={setDeclineReason}
              placeholder="Reason (required)"
              placeholderTextColor="#94A3B8"
              multiline
              numberOfLines={3}
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-un1t-text text-sm"
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
            <View className="flex-row items-center justify-end gap-2 mt-3">
              <Pressable
                onPress={() => { setShowDecline(false); setDeclineReason('') }}
                className="px-3 py-2 rounded-md border border-un1t-border active:bg-un1t-border/30"
              >
                <Text className="text-xs text-un1t-subtle">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleDecline}
                disabled={busy}
                className={`px-3 py-2 rounded-md ${busy ? 'bg-red-500/40' : 'bg-red-600 active:opacity-80'}`}
              >
                <Text className="text-xs font-semibold text-white">
                  {busy ? 'Sending…' : 'Decline contract'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
