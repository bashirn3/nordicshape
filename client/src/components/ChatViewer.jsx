import { useEffect, useMemo, useRef } from 'react';
import { Bot, Check, CheckCheck, Eye, User } from 'lucide-react';

const DISPLAY_TIME_ZONE = 'Europe/Helsinki';

export default function ChatViewer({ messages = [], loading }) {
  const scrollRef = useRef(null);
  const grouped = useMemo(() => groupByDay(messages), [messages]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  if (loading) {
    return (
      <div className="chat-empty">
        Loading chat...
      </div>
    );
  }

  if (!messages.length) {
    return (
      <div className="chat-empty">
        No chat messages yet.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="chat-scroll">
      {grouped.map(({ day, items }) => (
        <section key={day} className="chat-day">
          <div className="day-label">{day}</div>
          {items.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Message({ message }) {
  const isHuman = message.type === 'human';
  const Icon = isHuman ? User : Bot;
  return (
    <div className={`chat-row ${isHuman ? 'human' : 'ai'}`}>
      <div className="bubble">
        {message.text}
      </div>
      <div className="bubble-meta">
        <Icon size={11} />
        <span>{timeOfDay(message.created_at)}</span>
        {message.status && <StatusPill status={message.status} />}
        {!isHuman && <DeliveryIcon status={message.delivery_status} />}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'opted_out' || normalized === 'whatsapp_opt_out') {
    return <span className="pill danger">Opted out</span>;
  }
  if (normalized === 'replied') return <span className="pill success">Replied</span>;
  return null;
}

function DeliveryIcon({ status }) {
  if (status === 'read') return <Eye size={11} />;
  if (status === 'delivered') return <CheckCheck size={11} />;
  if (status === 'sent' || status === 'pending') return <Check size={11} />;
  return null;
}

function groupByDay(messages) {
  const byDay = new Map();
  for (const message of messages) {
    const key = message.created_at ? dateKey(new Date(message.created_at)) : 'unknown';
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(message);
  }
  return Array.from(byDay.entries()).map(([key, items]) => ({
    day: key === 'unknown' ? 'Unknown' : dayLabel(new Date(items[0].created_at)),
    items,
  }));
}

function timeOfDay(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function dayLabel(date) {
  const key = dateKey(date);
  if (key === dateKey(new Date())) return 'Today';
  if (key === dateKey(new Date(Date.now() - 86400000))) return 'Yesterday';

  const sameYear = dateParts(date).year === dateParts(new Date()).year;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

function dateKey(date) {
  const { year, month, day } = dateParts(date);
  return `${year}-${month}-${day}`;
}

function dateParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
