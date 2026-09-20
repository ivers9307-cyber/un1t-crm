// COVERLOOP.2 — the confirm step before a swap request is sent (targeted at
// one coach, or posted to the open pool), with the optional reason the API has
// always accepted and the phone never collected.
//
// A sheet, not an Alert: Alert.prompt is iOS-only and the reason needs a text
// field on Android too. Thin on purpose. Every word it shows comes from
// swapConfirmCopy (mobile/lib/swap-cards.js), which is where the tests are:
// there is no React Native component test runner in this repo. The caller
// normalises the reason with swapReasonForPost before POSTing it.
import { useState, useEffect } from 'react'
import {
  View, Text, Pressable, Modal, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SWAP_REASON_MAX } from '../../lib/swap-cards'

export default function SwapConfirmSheet({ visible, copy, sending, onConfirm, onClose }) {
  const [reason, setReason] = useState('')

  // A freshly opened sheet never inherits the last request's reason.
  useEffect(() => { if (visible) setReason('') }, [visible])

  if (!visible || !copy) return null
  return (
    <Modal visible animationType="slide" transparent onRequestClose={sending ? undefined : onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 justify-end bg-black/50"
      >
        <Pressable className="flex-1" onPress={sending ? undefined : onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">{copy.title}</Text>
            <Pressable onPress={onClose} disabled={sending} hitSlop={10}>
              <Ionicons name="close" size={22} color="#94A3B8" />
            </Pressable>
          </View>

          <Text className="text-sm text-un1t-text mb-4">{copy.message}</Text>

          <Text className="text-xs uppercase font-semibold text-un1t-subtle mb-1.5">Reason (optional)</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. physio appointment"
            placeholderTextColor="#64748B"
            maxLength={SWAP_REASON_MAX}
            multiline
            editable={!sending}
            className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text"
            style={{ minHeight: 72, textAlignVertical: 'top' }}
          />
          <Text className="text-[11px] text-un1t-subtle mt-1 mb-4">{copy.reasonHint}</Text>

          <Pressable
            onPress={() => onConfirm(reason)}
            disabled={sending}
            className="bg-un1t-text active:opacity-80 disabled:opacity-50 px-4 py-3.5 rounded-xl items-center flex-row justify-center"
          >
            {sending ? <ActivityIndicator color="#FFFFFF" /> : null}
            <Text className="text-base font-semibold text-un1t-bg ml-2">{sending ? 'Sending…' : copy.cta}</Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            disabled={sending}
            className="mt-2 active:opacity-70 px-4 py-3 rounded-xl items-center"
          >
            <Text className="text-sm font-medium text-un1t-subtle">Back</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
