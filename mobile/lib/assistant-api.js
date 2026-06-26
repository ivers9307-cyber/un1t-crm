// MOBILE-ASSISTANT.1 — the in-app AI assistant chat (P2-8).
//
// Thin client over the existing /api/assistant/chat route. The server
// derives role / userId / locationId from the session (the api()
// wrapper attaches the Bearer token + x-active-location), so the
// client only contributes the message history and a display-only
// currentPage hint. We ship the BUFFERED (non-streaming) path: omit
// `stream` and the route returns { response, navigateTo } as JSON.
// Streaming (text/event-stream) is a planned fast-follow.

import { api } from './api'

/**
 * Send the chat history to the assistant and get the buffered reply.
 *
 * @param {{ role: 'user'|'assistant', content: string }[]} messages  1–200 turns
 * @param {object} [opts]
 * @param {string} [opts.currentPage]  raw expo-router pathname — the server sanitises it
 * @returns {Promise<{ success: boolean, response?: string, navigateTo?: string|null, error?: string }>}
 */
export function sendAssistantChat(messages, { currentPage } = {}) {
  return api('/api/assistant/chat', {
    method: 'POST',
    body: { messages, userContext: { currentPage } },
  })
}
