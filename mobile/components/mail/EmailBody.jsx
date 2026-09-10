// MAIL-READER.M1 — a stranger's email, drawn with React Native primitives.
//
// 🔴 THIS COMPONENT HOLDS NO DECISIONS. Every one of them is a pure function in
// mobile/lib/mail-blocks.js, because vitest reaches mobile/lib and nothing else
// under mobile/ — there is no runner for this directory and no jsdom in this
// project. If you are about to write an `if` here that is not "which element
// draws this block", it belongs in the lib.
//
// WHERE THE TREE COMES FROM. src/lib/email-blocks.js walks the ALREADY
// SANITISED html server-side and the route serves it under ?body=blocks.
// Nothing is parsed on this device and there is no HTML engine in this app:
// react-native-webview is a native module, which would mean a new binary and
// App Review. So Layer 1 is not a sandboxed iframe here — it is the ABSENCE of
// an engine. No script can run because nothing can interpret one, and the
// Supabase session lives in SecureStore rather than a cookie a frame could
// reach.
//
// IMAGES. `blocked` is the only URL an image block carries — the value
// email-html.js parked, already proven there to be an absolute http(s) URL. The
// operator pressing "Show images" is the ONLY thing that turns it into a fetch,
// and the sentence beside it says why that is a decision and not a setting: a
// remote image in an email is usually a tracking pixel, and loading it reports
// the read to a stranger.
//
// NO `truncated` PROP HERE (Amendment, Task 5's review). `html_truncated` is
// meaningful even when `html_blocks` is null — a message can lose everything
// to a cap and still owe the reader a notice — and this component returns
// `null` outright whenever `normaliseBlocks` comes back empty, which is
// exactly that case. A truncation notice living in here would silently stop
// rendering on the one message that most needs it. The caller
// (app/(staff)/email/[conversationId].jsx) reads `msg.html_truncated`
// directly, off the flag, next to its `html_unsafe`/`html_omitted` siblings,
// regardless of which branch — blocks or text — actually drew the body.

import React, { useState } from 'react'
import { View, Text, Image, Pressable, ScrollView, Linking, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { normaliseBlocks, imageState, blockedImageCount, linkLabel } from '../../lib/mail-blocks'

const HEADING_SIZE = {
  1: 'text-[19px]', 2: 'text-[17px]', 3: 'text-[16px]',
  4: 'text-[15px]', 5: 'text-[14px]', 6: 'text-[13px]',
}

function openHref(href) {
  Linking.openURL(href).catch(() => Alert.alert('Could not open that link', href))
}

/** One run of inline text. */
function Run({ run }) {
  const classes = [
    run.bold ? 'font-bold' : '',
    run.italic ? 'italic' : '',
    run.strike ? 'line-through' : '',
    run.mono ? 'font-mono' : '',
    run.href ? 'text-blue-700 underline' : 'text-un1t-text',
  ].filter(Boolean).join(' ')
  if (!run.href) return <Text className={classes}>{run.text}</Text>
  return (
    <Text
      className={classes}
      accessibilityRole="link"
      onPress={() => openHref(run.href)}
      onLongPress={() => Alert.alert('Link', run.href)}
    >
      {linkLabel(run.href, run.text)}
    </Text>
  )
}

function Runs({ runs }) {
  return <>{runs.map((run, i) => <Run key={i} run={run} />)}</>
}

function BlockedImage({ block }) {
  return (
    <View className="flex-row items-center rounded-lg border border-dashed border-un1t-border bg-un1t-surface px-2.5 py-2 mb-2">
      <Ionicons name="image-outline" size={13} color="#94A3B8" style={{ marginRight: 6 }} />
      <Text className="text-[11px] text-un1t-muted flex-1" numberOfLines={1}>
        {block.alt || 'Image not loaded'}
      </Text>
    </View>
  )
}

function Block({ block, showImages }) {
  switch (block.type) {
    case 'heading':
      return (
        <Text className={`${HEADING_SIZE[block.level]} font-extrabold text-un1t-text mb-2`}>
          <Runs runs={block.runs} />
        </Text>
      )
    case 'para':
      return <Text className="text-[15px] leading-[21px] mb-2.5"><Runs runs={block.runs} /></Text>
    case 'list':
      return (
        <View className="mb-2.5">
          {block.items.map((item, i) => (
            <View key={i} className="flex-row mb-1">
              <Text className="text-[15px] text-un1t-subtle mr-2">
                {block.ordered ? `${i + 1}.` : '•'}
              </Text>
              <Text className="text-[15px] leading-[21px] flex-1"><Runs runs={item} /></Text>
            </View>
          ))}
        </View>
      )
    case 'quote':
      return (
        <View className="border-l-2 border-un1t-border pl-3 mb-2.5">
          {block.blocks.map((inner, i) => (
            <Block key={i} block={inner} showImages={showImages} />
          ))}
        </View>
      )
    case 'link': {
      const label = linkLabel(block.href, block.runs.map(r => r.text).join(''))
      return (
        <Pressable
          onPress={() => openHref(block.href)}
          onLongPress={() => Alert.alert('Link', block.href)}
          accessibilityRole="link"
          accessibilityLabel={label}
          className="flex-row items-center justify-between rounded-xl border border-un1t-text px-3 py-2.5 mb-2.5 active:opacity-70"
        >
          <Text className="text-[13px] font-bold text-un1t-text flex-1" numberOfLines={2}>
            {label}
          </Text>
          <Ionicons name="open-outline" size={14} color="#111827" style={{ marginLeft: 8 }} />
        </Pressable>
      )
    }
    case 'image': {
      const shown = imageState(block, showImages) === 'shown'
      const art = shown
        ? (
          <Image
            source={{ uri: block.blocked }}
            accessibilityLabel={block.alt || 'Image from this email'}
            resizeMode="contain"
            className="w-full h-40 mb-2.5"
          />
        )
        : <BlockedImage block={block} />
      // 🔴 A LINKED IMAGE STAYS TAPPABLE IN BOTH STATES. Marketing email is
      // routinely one hero image that IS the call to action, and images are
      // blocked by default here — so if only the shown state were tappable,
      // the operator's default view would be a dead placeholder with no way
      // to reach what it linked to.
      if (!block.href) return art
      return (
        <Pressable
          onPress={() => openHref(block.href)}
          onLongPress={() => Alert.alert('Link', block.href)}
          accessibilityRole="link"
          accessibilityLabel={block.alt ? `${block.alt} — opens a link` : 'Image link'}
          className="active:opacity-70"
        >
          {art}
        </Pressable>
      )
    }
    case 'rule':
      return <View className="h-px bg-un1t-border my-2.5" />
    case 'pre':
      return (
        <ScrollView horizontal className="mb-2.5" showsHorizontalScrollIndicator={false}>
          <Text className="font-mono text-[12px] text-un1t-text">{block.text}</Text>
        </ScrollView>
      )
    case 'table':
      // A data table — it carried a <th> or <thead>, so it is worth its own
      // scroll rather than being flattened into the column.
      return (
        <ScrollView horizontal className="mb-2.5" showsHorizontalScrollIndicator={false}>
          <View>
            {block.head ? (
              <View className="flex-row border-b border-un1t-border">
                {block.head.map((cell, i) => (
                  <Text key={i} className="text-[12px] font-bold text-un1t-text px-2 py-1.5 min-w-[92px]">
                    <Runs runs={cell} />
                  </Text>
                ))}
              </View>
            ) : null}
            {block.rows.map((row, r) => (
              <View key={r} className="flex-row border-b border-un1t-border">
                {row.map((cell, c) => (
                  <Text key={c} className="text-[12px] text-un1t-text px-2 py-1.5 min-w-[92px]">
                    <Runs runs={cell} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    default:
      // normaliseBlocks already dropped unknown types; this is the belt.
      return null
  }
}

/**
 * @param {object[]} blocks  the tree from html_blocks (or html_quoted_blocks)
 */
export default function EmailBody({ blocks }) {
  const [showImages, setShowImages] = useState(false)
  const safe = normaliseBlocks(blocks)
  if (safe.length === 0) return null
  const blockedCount = blockedImageCount(safe)

  return (
    <View className="mt-2">
      {blockedCount > 0 ? (
        <View className="mb-2">
          <Pressable
            onPress={() => setShowImages(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={showImages ? 'Hide images' : `Show ${blockedCount} images`}
            className="self-start flex-row items-center"
          >
            <Ionicons name="image-outline" size={12} color="#1E293B" style={{ marginRight: 5 }} />
            <Text className="text-[11px] font-semibold text-un1t-accent underline">
              {showImages ? 'Hide images' : `Show images (${blockedCount})`}
            </Text>
          </Pressable>
          {!showImages ? (
            // Said plainly, because it is a privacy decision made on the
            // member's behalf. Desktop's wording, verbatim.
            <Text className="text-[10px] text-un1t-muted mt-1">
              Remote images blocked — loading them tells the sender you read this
            </Text>
          ) : null}
        </View>
      ) : null}

      {safe.map((block, i) => <Block key={i} block={block} showImages={showImages} />)}
    </View>
  )
}
