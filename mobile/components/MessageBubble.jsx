// Shared chat bubble for the mobile messaging threads (WhatsApp +
// Instagram). Channel-agnostic: renders direction, the Mia tag on
// agent-sourced replies, template labels (WhatsApp only — IG rows just
// never carry template_name), media-type chips, delivery ticks, and
// the 👍👎 quality row on agent replies (AGENT-QA.1).

import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { mediaLabel } from '../lib/inbox'

export default function MessageBubble({ msg, myRating, onRate }) {
  const out = msg.direction === 'outbound'
  const isAgent = msg.source === 'agent'
  const media = mediaLabel(msg.message_type)
  const time = msg.created_at
    ? new Date(msg.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : ''
  return (
    <>
      <View className={`flex-row mb-1.5 ${out ? 'justify-end' : 'justify-start'}`}>
        <View
          className={`max-w-[80%] px-3.5 py-2 rounded-2xl ${
            out ? 'bg-blue-500' : 'bg-un1t-surface border border-un1t-border'
          }`}
        >
          {isAgent && (
            <View className="flex-row items-center mb-1">
              <Ionicons name="sparkles" size={10} color={out ? 'rgba(255,255,255,0.8)' : '#64748B'} />
              <Text className={`text-[10px] uppercase ml-1 font-semibold ${out ? 'text-white/70' : 'text-un1t-muted'}`}>
                Mia
              </Text>
            </View>
          )}
          {msg.template_name && (
            <Text className={`text-[10px] uppercase mb-1 ${out ? 'text-white/70' : 'text-un1t-muted'}`}>
              Template · {msg.template_name}
            </Text>
          )}
          {media && (
            <View className={`flex-row items-center ${msg.body ? 'mb-0.5' : ''}`}>
              <Ionicons name={media.icon} size={14} color={out ? 'rgba(255,255,255,0.85)' : '#64748B'} />
              <Text className={`text-sm italic ml-1.5 ${out ? 'text-white/85' : 'text-un1t-light'}`}>
                {media.label}
              </Text>
            </View>
          )}
          {msg.body ? (
            <Text className={`text-base ${out ? 'text-white' : 'text-un1t-text'}`}>
              {msg.body}
            </Text>
          ) : !media ? (
            <Text className={`text-base ${out ? 'text-white' : 'text-un1t-text'}`}>—</Text>
          ) : null}
          <View className="flex-row items-center justify-end mt-1">
            <Text className={`text-[10px] ${out ? 'text-white/60' : 'text-un1t-subtle'}`}>
              {time}
            </Text>
            {out && (
              <Ionicons
                name={
                  msg.read_at ? 'checkmark-done'
                  : msg.delivered_at ? 'checkmark-done'
                  : msg.status === 'sent' ? 'checkmark'
                  : msg.status === 'failed' ? 'alert-circle'
                  : msg.status === 'delivered' ? 'checkmark-done'
                  : 'time-outline'
                }
                size={12}
                color={msg.read_at ? '#FFFFFF' : 'rgba(255,255,255,0.6)'}
                style={{ marginLeft: 4 }}
              />
            )}
          </View>
        </View>
      </View>
      {/* Thumbs on agent replies — ratings land on the agent analytics
          quality list, same loop as the web inbox. */}
      {isAgent && onRate && (
        <View className="flex-row justify-end items-center mb-2 mr-1 -mt-0.5">
          <Pressable onPress={() => onRate(msg, 'up')} hitSlop={8} className="mr-4">
            <Ionicons
              name={myRating === 'up' ? 'thumbs-up' : 'thumbs-up-outline'}
              size={14}
              color={myRating === 'up' ? '#16A34A' : '#94A3B8'}
            />
          </Pressable>
          <Pressable onPress={() => onRate(msg, 'down')} hitSlop={8}>
            <Ionicons
              name={myRating === 'down' ? 'thumbs-down' : 'thumbs-down-outline'}
              size={14}
              color={myRating === 'down' ? '#DC2626' : '#94A3B8'}
            />
          </Pressable>
        </View>
      )}
    </>
  )
}
