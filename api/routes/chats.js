import { Router } from 'express';
import { requireSupabase } from '../lib/supabase.js';
import {
  extractMessage,
  mergeChatTimeline,
  normalizePhone,
  normalizeText,
  sessionIdsFor,
} from '../lib/chat.js';

const router = Router();
const OPT_OUT_ACK_TEXT = 'Selvä, kiitos ilmoituksesta. Emme jatka viestittelyä tähän numeroon.';

router.get('/:clientKey/:phone', async (req, res, next) => {
  try {
    const db = requireSupabase();
    const clientKey = req.params.clientKey;
    const phone = normalizePhone(req.params.phone);
    const sessionIds = sessionIdsFor(clientKey, req.params.phone);

    const [chatRes, statusRes, sessionRes] = await Promise.all([
      db
        .from('chat_history')
        .select('id, session_id, message, timestamp')
        .in('session_id', sessionIds)
        .order('timestamp', { ascending: true })
        .order('id', { ascending: true }),
      db
        .from('campaign_message_status')
        .select('provider_message_id, status, occurred_at')
        .eq('client_key', clientKey)
        .eq('number', phone)
        .order('occurred_at', { ascending: true }),
      db
        .from('campaign_outbound_sessions')
        .select('id, number, first_outbound_at, last_outbound_at, last_inbound_at, inbound_count, provider_message_id, stop_reason, opt_out_at, raw_data')
        .eq('client_key', clientKey)
        .eq('number', phone)
        .order('first_outbound_at', { ascending: true }),
    ]);

    if (chatRes.error) throw chatRes.error;
    if (statusRes.error) throw statusRes.error;
    if (sessionRes.error) throw sessionRes.error;

    const statusByMessageId = buildStatusMap(statusRes.data || []);
    const memoryMessages = (chatRes.data || []).map((row) => extractMessage(row, statusByMessageId)).filter(Boolean);
    const fallbackMessages = [
      ...buildSyntheticOutbound(sessionRes.data || [], statusByMessageId),
      ...buildSyntheticInbound(sessionRes.data || [], memoryMessages),
    ];
    const messages = mergeChatTimeline(memoryMessages, fallbackMessages);

    res.json({
      client_key: clientKey,
      phone,
      session_id: sessionIds[0],
      session_ids: sessionIds,
      messages,
    });
  } catch (err) {
    next(err);
  }
});

function buildStatusMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.provider_message_id) continue;
    map.set(row.provider_message_id, row);
  }
  return map;
}

function buildSyntheticOutbound(sessions, statusByMessageId) {
  return sessions
    .map((session) => {
      const message = session.raw_data?.outbound?.message;
      if (!message || String(message).startsWith('[removed:')) return null;
      const status = session.provider_message_id ? statusByMessageId.get(session.provider_message_id) : null;
      return {
        id: `session-${session.id}`,
        type: 'ai',
        text: message,
        created_at: session.last_outbound_at || session.first_outbound_at,
        delivery_status: status?.status || 'sent',
        provider_message_id: session.provider_message_id || null,
        source: 'outbound_session',
      };
    })
    .filter(Boolean);
}

function buildSyntheticInbound(sessions, memoryMessages) {
  return sessions
    .flatMap((session) => {
      const messages = [];
      const lastInbound = session.raw_data?.last_inbound?.inbound;
      const optOut = session.raw_data?.opt_out?.inbound;
      const backfill = session.raw_data?.inbound_backfill_2026_06_02;
      const isOptOut = Boolean(optOut?.message || backfill?.is_opt_out || session.stop_reason === 'whatsapp_opt_out');
      const optOutAt = optOut?.created_at || session.opt_out_at || session.last_inbound_at || backfill?.occurred_at;

      if (lastInbound?.message) {
        if (!hasHumanMemoryMessage(memoryMessages, lastInbound.message)) {
          messages.push(inboundMessage(session, {
            id: `session-${session.id}-inbound`,
            text: lastInbound.message,
            created_at: lastInbound.created_at || session.last_inbound_at,
            status: isOptOut ? 'opted_out' : 'replied',
          }));
        }
      } else if (optOut?.message) {
        if (!hasHumanMemoryMessage(memoryMessages, optOut.message)) {
          messages.push(inboundMessage(session, {
            id: `session-${session.id}-opt-out`,
            text: optOut.message,
            created_at: optOutAt,
            status: 'opted_out',
          }));
        }
      } else if (backfill?.is_opt_out || session.stop_reason === 'whatsapp_opt_out') {
        if (!hasHumanMemoryMessage(memoryMessages, 'Ei kiitos')) {
          messages.push(inboundMessage(session, {
            id: `session-${session.id}-opt-out`,
            text: 'Ei kiitos',
            created_at: optOutAt,
            status: 'opted_out',
          }));
        }
      } else if (session.last_inbound_at) {
        if (memoryMessages.some((message) => message.type === 'human')) return messages;
        messages.push(inboundMessage(session, {
          id: `session-${session.id}-inbound`,
          text: 'Customer replied',
          created_at: session.last_inbound_at,
          status: 'replied',
        }));
      }

      if (isOptOut && optOutAt && !hasAiMemoryMessage(memoryMessages, OPT_OUT_ACK_TEXT)) {
        messages.push(optOutAckMessage(session, optOutAt));
      }

      return messages;
    })
    .filter((message) => message.text && message.created_at);
}

function hasHumanMemoryMessage(memoryMessages, text) {
  const normalized = normalizeText(text);
  return memoryMessages.some((message) => message.type === 'human' && normalizeText(message.text) === normalized);
}

function hasAiMemoryMessage(memoryMessages, text) {
  const normalized = normalizeText(text);
  return memoryMessages.some((message) => message.type === 'ai' && normalizeText(message.text) === normalized);
}

function inboundMessage(session, message) {
  return {
    type: 'human',
    source: 'outbound_session',
    number: session.number,
    ...message,
  };
}

function optOutAckMessage(session, timestamp) {
  return {
    id: `session-${session.id}-opt-out-ack`,
    type: 'ai',
    text: OPT_OUT_ACK_TEXT,
    created_at: addSeconds(timestamp, 1),
    delivery_status: 'sent',
    source: 'opt_out_ack',
  };
}

function addSeconds(value, seconds) {
  const date = value ? new Date(value) : new Date();
  date.setSeconds(date.getSeconds() + seconds);
  return date.toISOString();
}

export default router;
