export function normalizePhone(value) {
  let phone = String(value || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('0')) phone = `358${phone.slice(1)}`;
  return phone;
}

export function sessionIdsFor(clientKey, value) {
  const raw = String(value || '').trim();
  const normalized = normalizePhone(raw);
  const ids = new Set();

  if (normalized) ids.add(`${clientKey}-${normalized}`);
  if (raw) ids.add(`${clientKey}-${raw}`);
  if (normalized && !raw.startsWith('+')) ids.add(`${clientKey}-+${normalized}`);

  return Array.from(ids);
}

export function extractMessage(row, statusByMessageId) {
  const msg = row.message || {};
  const type = msg.type || 'system';
  if (type === 'tool') return null;

  const rawContent = typeof msg.content === 'string'
    ? msg.content
    : (msg.data?.content ?? '');
  const kwargs = msg.additional_kwargs || msg.data?.additional_kwargs || {};
  const toolCalls = msg.tool_calls || msg.data?.tool_calls || [];

  if (type === 'ai' && toolCalls.length > 0 && !rawContent) return null;
  if (type === 'ai' && /^Calling \w/i.test(rawContent)) return null;
  if (type === 'ai' && rawContent.startsWith('[{"success"')) return null;

  let text = rawContent;
  let parsed = null;
  if (type === 'human' && rawContent.includes('User message: ')) {
    text = rawContent.split('User message: ').slice(1).join('User message: ');
  }
  if (type === 'ai' && typeof rawContent === 'string' && rawContent.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(rawContent);
      text = parsed.message || parsed.output || parsed.text || rawContent;
    } catch {}
  }
  if (!text || !String(text).trim()) return null;

  const providerMessageId = kwargs.wamid || kwargs.message_id || kwargs.provider_message_id || null;
  const status = providerMessageId ? statusByMessageId.get(providerMessageId) : null;

  return {
    id: row.id,
    session_id: row.session_id,
    type,
    text,
    parsed,
    raw_content: rawContent,
    created_at: row.timestamp || row.created_at || null,
    delivery_status: status?.status || (type === 'ai' ? 'sent' : null),
    provider_message_id: providerMessageId,
    source: 'chat_history',
  };
}

export function mergeChatTimeline(primaryMessages, fallbackMessages) {
  const timeline = [...primaryMessages];
  for (const fallback of fallbackMessages) {
    if (!hasMatchingPrimary(primaryMessages, fallback)) timeline.push(fallback);
  }

  return dedupeConsecutive(
    timeline.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)),
  );
}

function hasMatchingPrimary(primaryMessages, fallback) {
  const fallbackText = normalizeText(fallback.text);
  if (!fallbackText) return false;

  return primaryMessages.some((message) => {
    if (message.type !== fallback.type) return false;
    if (normalizeText(message.text) !== fallbackText) return false;
    if (!message.created_at || !fallback.created_at) return true;

    const delta = Math.abs(new Date(message.created_at) - new Date(fallback.created_at));
    return delta < 10 * 60 * 1000;
  });
}

function dedupeConsecutive(messages) {
  const out = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === message.type &&
      normalizeText(prev.text) === normalizeText(message.text) &&
      prev.created_at &&
      message.created_at &&
      Math.abs(new Date(message.created_at) - new Date(prev.created_at)) < 2000
    ) {
      continue;
    }
    out.push(message);
  }
  return out;
}

export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
