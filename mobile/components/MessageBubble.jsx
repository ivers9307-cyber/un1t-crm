// Shared chat bubble for the mobile messaging threads (WhatsApp +
// Instagram). Channel-agnostic: renders direction, the Mia tag on
// agent-sourced replies, template labels (WhatsApp only — IG rows just
// never carry template_name), media-type chips, delivery ticks, the
// 👍❤️🔥 react row on inbound WhatsApp messages (C6 — pass onReact),
// and the 👍👎 quality row on agent replies (AGENT-QA.1).

import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { mediaLabel } from '../lib/inbox'
import { isServableMedia, isServableInstagramMedia } from 'shared/whatsapp-media'
import WAMediaThumb from './WAMediaThumb'

// C6 — same three emoji the web inbox offers.
const REACTION_EMOJI = ['👍', '❤️', '🔥']

export default function MessageBubble({ msg, myRating, onRate, onReact, reactingId, channel }) {
  const out = msg.direction === 'outbound'
  const isAgent = msg.source === 'agent'
  // IG-MEDIA.3 — both channels re-host through their own media route and render
  // inline. The servable test differs per channel and is NOT interchangeable:
  // WhatsApp fetches from Meta by media id, Instagram by a CDN url, so the
  // WhatsApp test rejects every IG row. Instagram used to fall through to the
  // chip, which showed nothing at all once story mentions stopped carrying a
  // text placeholder.
  const showMedia = channel === 'instagram'
    ? isServableInstagramMedia(msg)
    : channel === 'whatsapp' && isServableMedia(msg)
  const media = !showMedia && mediaLabel(msg.message_type)
  // IG-MEDIA.4 — the stored body for an attachment with no caption is the
  // literal "[type]" placeholder, which the chip above already says in plain
  // words. Rendering both gave "📎 Story mention" with "[story_mention]" under
  // it. Show the placeholder only when nothing else stands in for the
  // attachment, so the bubble is never empty either.
  const isTypePlaceholder = msg.body === `[${msg.message_type}]`
  const bodyText = isTypePlaceholder && (media || showMedia) ? '' : msg.body
  // 'played' (voice note listened to) is the strongest read signal there
  // is — the webhook stamps read_at for it, but honour the status too so
  // the ticks read correctly even before/without that stamp.
  const isRead = Boolean(msg.read_at) || msg.status === 'read' || msg.status === 'played'
  // C6 — react to a customer message (WhatsApp only; needs the Meta id).
  const canReact = channel === 'whatsapp' && !out && !!msg.wa_message_id && !!onReact
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
          {showMedia && (
            <View className={bodyText ? 'mb-1' : ''}>
              <WAMediaThumb msg={msg} channel={channel} />
            </View>
          )}
          {media && (
            <View className={`flex-row items-center ${bodyText ? 'mb-0.5' : ''}`}>
              <Ionicons name={media.icon} size={14} color={out ? 'rgba(255,255,255,0.85)' : '#64748B'} />
              <Text className={`text-sm italic ml-1.5 ${out ? 'text-white/85' : 'text-un1t-subtle'}`}>
                {media.label}
              </Text>
            </View>
          )}
          {bodyText ? (
            <Text className={`text-base ${out ? 'text-white' : 'text-un1t-text'}`}>
              {bodyText}
            </Text>
          ) : (!media && !showMedia) ? (
            <Text className={`text-base ${out ? 'text-white' : 'text-un1t-text'}`}>—</Text>
          ) : null}
          <View className="flex-row items-center justify-end mt-1">
            {/* C6 — react to a customer message (👍 ❤️ 🔥); the route logs
                a thread row that shows on the next refresh, like web. */}
            {canReact && (
              <View className="flex-row items-center flex-1">
                {REACTION_EMOJI.map(emoji => (
                  <Pressable
                    key={emoji}
                    onPress={() => onReact(msg, emoji)}
                    disabled={reactingId === msg.id}
                    hitSlop={6}
                    className="mr-3"
                  >
                    <Text className={`text-[13px] ${reactingId === msg.id ? 'opacity-20' : 'opacity-40'}`}>
                      {emoji}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <Text className={`text-[10px] ${out ? 'text-white/60' : 'text-un1t-subtle'}`}>
              {time}
            </Text>
            {out && (
              <Ionicons
                name={
                  isRead ? 'checkmark-done'
                  : msg.delivered_at ? 'checkmark-done'
                  : msg.status === 'sent' ? 'checkmark'
                  : msg.status === 'failed' ? 'alert-circle'
                  : msg.status === 'delivered' ? 'checkmark-done'
                  : 'time-outline'
                }
                size={12}
                color={isRead ? '#FFFFFF' : 'rgba(255,255,255,0.6)'}
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
