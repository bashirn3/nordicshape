import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Clock, MessageCircle, Play, Settings, X } from 'lucide-react';
import { fetchCampaign, fetchChat, updateSettings } from './lib/api.js';
import ChatViewer from './components/ChatViewer.jsx';

const DEFAULT_CLIENT = import.meta.env.VITE_CAMPAIGN_CLIENT_KEY || 'nordicshape';
const DISPLAY_TIME_ZONE = 'Europe/Helsinki';
const SESSIONS_PER_PAGE = 50;
const SESSION_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'reminded', label: 'Reminded' },
  { value: 'replied', label: 'Replied' },
  { value: 'opted_out', label: 'Opted out' },
];

export default function App() {
  const [clientKey] = useState(DEFAULT_CLIENT);
  const [selectedChat, setSelectedChat] = useState(null);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionFilter, setSessionFilter] = useState('all');
  const campaignQuery = useQuery({
    queryKey: ['campaign', clientKey, sessionsPage, sessionFilter],
    queryFn: () => fetchCampaign(clientKey, {
      sessions_page: sessionsPage,
      sessions_limit: SESSIONS_PER_PAGE,
      sessions_status: sessionFilter,
    }),
    refetchInterval: 60_000,
  });

  if (campaignQuery.isLoading) return <Shell><div className="card">Loading campaign data...</div></Shell>;
  if (campaignQuery.isError) {
    return (
      <Shell>
        <div className="card error">
          Could not load campaign. Apply `db/schema.sql` and check Supabase env vars.
        </div>
      </Shell>
    );
  }

  const data = campaignQuery.data;
  return (
    <Shell>
      <header className="hero">
        <div>
          <p className="eyebrow">WhatsApp Campaign</p>
          <h1>{data.config?.display_name || clientKey}</h1>
          <p className="muted">
            Track the live outreach queue, replies, opt-outs, and launch controls.
          </p>
        </div>
      </header>

      <KpiGrid summary={data.summary || {}} />
      <SettingsPanel config={data.config} clientKey={clientKey} />

      <Panel title="Outreach History" description="Showing contacted prospects and their latest campaign status.">
        <SessionsTable
          rows={data.recent_sessions || []}
          pagination={data.recent_sessions_pagination}
          filter={sessionFilter}
          onFilterChange={(filter) => {
            setSessionFilter(filter);
            setSessionsPage(1);
          }}
          onOpenChat={setSelectedChat}
          onPageChange={setSessionsPage}
        />
      </Panel>

      {selectedChat && (
        <ChatDrawer
          clientKey={clientKey}
          session={selectedChat}
          onClose={() => setSelectedChat(null)}
        />
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <main className="shell">
      {children}
    </main>
  );
}

function KpiGrid({ summary }) {
  const cards = [
    { label: 'Eligible prospects', value: summary.eligible_prospects, icon: Play },
    { label: 'Contacted', value: summary.contacted, icon: MessageCircle },
    { label: 'Replied', value: summary.replied, icon: MessageCircle },
    { label: 'Opt-outs', value: summary.opt_outs, icon: X },
    { label: 'Reminded', value: summary.reminded, icon: Bell },
    { label: 'Reminder due', value: summary.reminder_due, icon: Clock },
  ];

  return (
    <section className="kpis">
      {cards.map(({ label, value, icon: Icon, featured }) => (
        <div className={`card kpi ${featured ? 'featured' : ''}`} key={label}>
          <Icon size={18} />
          <span>{label}</span>
          <strong>{value ?? 0}</strong>
        </div>
      ))}
    </section>
  );
}

function SettingsPanel({ config, clientKey }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => ({
    outbound_enabled: Boolean(config?.outbound_enabled),
    daily_cap: config?.daily_cap || 20,
  }));

  const mutation = useMutation({
    mutationFn: () => updateSettings(clientKey, {
      outbound_enabled: draft.outbound_enabled,
      daily_cap: Number(draft.daily_cap),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaign', clientKey] }),
  });

  return (
    <Panel title="Settings" description="Safe launch controls. Workflow activation is still handled separately in n8n.">
      <div className="settings-grid">
        <label className="toggle-row">
          <span>
            <strong>Outbound enabled</strong>
            <small>Controls whether scheduled senders should run.</small>
          </span>
          <input
            type="checkbox"
            checked={draft.outbound_enabled}
            onChange={(event) => setDraft({ ...draft, outbound_enabled: event.target.checked })}
          />
        </label>
        <NumberField label="Daily cap" value={draft.daily_cap} onChange={(daily_cap) => setDraft({ ...draft, daily_cap })} />
        <button className="primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          <Settings size={16} />
          Save settings
        </button>
      </div>
    </Panel>
  );
}

function NumberField({ label, value, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Panel({ title, description, children }) {
  return (
    <section className="card panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SessionsTable({ rows, pagination, filter, onFilterChange, onOpenChat, onPageChange }) {
  const total = pagination?.total ?? rows.length;
  const page = pagination?.page ?? 1;
  const limit = pagination?.limit ?? (rows.length || SESSIONS_PER_PAGE);
  const totalPages = pagination?.total_pages ?? 1;
  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = total === 0 ? 0 : Math.min(total, start + rows.length - 1);

  const controls = (
    <div className="table-toolbar">
      <div className="segmented" aria-label="Outreach status filter">
        {SESSION_FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={filter === option.value ? 'active' : ''}
            onClick={() => onFilterChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (!rows.length) {
    return (
      <>
        {controls}
        <p className="empty">No outreach sessions found for this filter.</p>
      </>
    );
  }

  return (
    <>
      {controls}
      <div className="table-meta">
        <span>Showing {start}-{end} of {total}</span>
        <div className="pagination">
          <button className="secondary" type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button className="secondary" type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
            Next
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Contacted</th>
              <th>Reminder</th>
              <th>Reply</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.name || row.number}</strong>
                  <small className="cell-sub">{row.number}</small>
                </td>
                <td>{formatDate(row.first_outbound_at)}</td>
                <td>{row.reminder_sent_at ? formatDate(row.reminder_sent_at) : '-'}</td>
                <td>{row.last_inbound_at ? formatDate(row.last_inbound_at) : '-'}</td>
                <td><StatusPill status={statusForSession(row)} /></td>
                <td>
                  <button className="table-action" type="button" onClick={() => onOpenChat(row)}>
                    View chat
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ChatDrawer({ clientKey, session, onClose }) {
  const chatQuery = useQuery({
    queryKey: ['chat', clientKey, session.number],
    queryFn: () => fetchChat(clientKey, session.number),
  });

  return (
    <div className="drawer-backdrop">
      <aside className="chat-drawer card">
        <div className="drawer-head">
          <div>
            <h2>{session.name || session.number}</h2>
            <p>{session.number}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close chat">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-meta">
          <span>Session: {chatQuery.data?.session_id || `${clientKey}-${session.number}`}</span>
          <StatusPill status={statusForSession(session)} />
        </div>
        <ChatViewer messages={chatQuery.data?.messages || []} loading={chatQuery.isLoading} />
      </aside>
    </div>
  );
}

function StatusPill({ status }) {
  const meta = statusMeta(status);
  return <span className={`pill ${meta.tone}`}>{meta.label}</span>;
}

function statusForSession(session) {
  if (session.opt_out_at || session.stop_reminders || session.stop_reason) return 'opted_out';
  if (session.last_inbound_at) return 'replied';
  if (Number(session.outbound_count || 0) > 1) return 'reminded';
  return 'active';
}

function statusMeta(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'opted_out' || normalized === 'whatsapp_opt_out') {
    return { label: 'Opted out', tone: 'danger' };
  }
  if (normalized === 'replied') return { label: 'Replied', tone: 'success' };
  if (normalized === 'reminded') return { label: 'Reminded', tone: 'info' };
  if (normalized === 'active') return { label: 'Active', tone: 'neutral' };
  if (normalized === 'contacted') return { label: 'Contacted', tone: 'info' };
  return { label: toTitle(status || 'Active'), tone: 'neutral' };
}

function toTitle(value) {
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  const time = formatTime(date);
  const key = dateKey(date);
  if (key === dateKey(new Date())) return `Today, ${time}`;
  if (key === dateKey(new Date(Date.now() - 86400000))) return `Yesterday, ${time}`;

  const sameYear = dateParts(date).year === dateParts(new Date()).year;
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
  return `${day}, ${time}`;
}

function formatTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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
