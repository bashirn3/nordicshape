import { Router } from 'express';
import { fetchAll, requireSupabase } from '../lib/supabase.js';

const router = Router();

router.get('/:clientKey', async (req, res, next) => {
  try {
    const clientKey = req.params.clientKey;
    const sessionsPage = boundedInt(req.query.sessions_page, 1, 10_000, 1);
    const sessionsLimit = boundedInt(req.query.sessions_limit, 1, 100, 50);
    const sessionsStatus = normalizeSessionStatus(req.query.sessions_status);
    const db = requireSupabase();
    const [config, summary, eligibleProspects, sessionPage] = await Promise.all([
      getConfig(db, clientKey),
      getSummary(db, clientKey),
      getEligibleProspectCount(db, clientKey),
      getRecentSessions(db, clientKey, { page: sessionsPage, limit: sessionsLimit, status: sessionsStatus }),
    ]);

    res.json({
      client_key: clientKey,
      generated_at: new Date().toISOString(),
      config,
      summary: {
        ...summary,
        eligible_prospects: eligibleProspects,
      },
      recent_sessions: sessionPage.rows,
      recent_sessions_pagination: sessionPage.pagination,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:clientKey/recompute-attribution', async (req, res, next) => {
  try {
    const result = await recomputeAttribution(req.params.clientKey);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

async function getConfig(db, clientKey) {
  const { data, error } = await db
    .from('campaign_client_config')
    .select('*')
    .eq('client_key', clientKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Unknown campaign client "${clientKey}"`);
  return data;
}

async function getSummary(db, clientKey) {
  const [sessionsRes, attributionRes] = await Promise.all([
    db
      .from('campaign_outbound_sessions')
      .select('id, last_inbound_at, last_outbound_at, outbound_count, stop_reminders, stop_reason, opt_out_at')
      .eq('client_key', clientKey)
      .neq('source_system', 'manual_test'),
    db
      .from('campaign_attribution')
      .select('session_id')
      .eq('client_key', clientKey)
      .eq('within_attribution_window', true),
  ]);
  if (sessionsRes.error) throw sessionsRes.error;
  if (attributionRes.error) throw attributionRes.error;

  const sessions = sessionsRes.data || [];
  const attributedSessionIds = new Set((attributionRes.data || []).map((row) => row.session_id).filter(Boolean));

  return {
    contacted: sessions.length,
    replied: sessions.filter((session) => session.last_inbound_at).length,
    opt_outs: sessions.filter((session) => session.opt_out_at || session.stop_reminders || session.stop_reason).length,
    reminded: sessions.filter((session) => Number(session.outbound_count || 0) > 1).length,
    reminder_due: sessions.filter((session) => isReminderDue(session, attributedSessionIds)).length,
  };
}

async function getEligibleProspectCount(db, clientKey) {
  const { count, error } = await db
    .from('campaign_prospects')
    .select('*', { count: 'exact', head: true })
    .eq('client_key', clientKey)
    .neq('source_system', 'manual_test')
    .eq('eligible', true)
    .eq('status', 'pending');
  if (error) throw error;
  return count || 0;
}

async function getRecentSessions(db, clientKey, { page, limit, status }) {
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  let query = db
    .from('campaign_outbound_sessions')
    .select(`
      id,
      prospect_id,
      source_customer_id,
      number,
      email,
      first_outbound_at,
      last_outbound_at,
      last_inbound_at,
      outbound_count,
      stop_reminders,
      stop_reason,
      booked_at,
      attended_at,
      prospect:campaign_prospects(first_name,last_name,email,normalized_phone)
    `, { count: 'exact' })
    .eq('client_key', clientKey)
    .neq('source_system', 'manual_test');

  query = applySessionStatusFilter(query, status);

  const { data, error, count } = await query
    .order('first_outbound_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return {
    rows: (data || []).map((row) => ({
      ...row,
      name: [row.prospect?.first_name, row.prospect?.last_name].filter(Boolean).join(' '),
      reminder_sent_at: Number(row.outbound_count || 0) > 1 ? row.last_outbound_at : null,
    })),
    pagination: {
      page,
      limit,
      status,
      total: count || 0,
      total_pages: Math.max(1, Math.ceil((count || 0) / limit)),
    },
  };
}

function boundedInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeSessionStatus(value) {
  const allowed = new Set(['all', 'active', 'reminded', 'replied', 'opted_out']);
  const normalized = String(value || 'all').toLowerCase();
  return allowed.has(normalized) ? normalized : 'all';
}

function applySessionStatusFilter(query, status) {
  if (status === 'active') return onlyOpen(query).eq('outbound_count', 1);
  if (status === 'reminded') return onlyOpen(query).gt('outbound_count', 1);
  if (status === 'replied') return onlyNotStopped(query).not('last_inbound_at', 'is', null);
  if (status === 'opted_out') {
    return query.or('opt_out_at.not.is.null,stop_reminders.eq.true,stop_reason.not.is.null');
  }
  return query;
}

function onlyOpen(query) {
  return onlyNotStopped(query).is('last_inbound_at', null);
}

function onlyNotStopped(query) {
  return query
    .is('opt_out_at', null)
    .eq('stop_reminders', false)
    .is('stop_reason', null);
}

function isReminderDue(session, attributedSessionIds) {
  if (attributedSessionIds.has(session.id)) return false;
  if (session.last_inbound_at || session.opt_out_at || session.stop_reminders || session.stop_reason) return false;
  if (Number(session.outbound_count || 0) !== 1) return false;

  const lastOutbound = new Date(session.last_outbound_at).getTime();
  if (!Number.isFinite(lastOutbound)) return false;
  return lastOutbound < Date.now() - 48 * 3600 * 1000;
}

async function recomputeAttribution(clientKey) {
  const db = requireSupabase();
  const config = await getConfig(db, clientKey);
  const [sessions, appointments, existing] = await Promise.all([
    fetchAll(() =>
      db
        .from('campaign_outbound_sessions')
        .select('*')
        .eq('client_key', clientKey)
        .neq('source_system', 'manual_test')
        .order('first_outbound_at', { ascending: true })
    ),
    fetchAll(() =>
      db
        .from('campaign_appointments')
        .select('*')
        .eq('client_key', clientKey)
        .eq('deleted', false)
        .order('source_created_at', { ascending: true })
    ),
    fetchAll(() =>
      db
        .from('campaign_attribution')
        .select('id')
        .eq('client_key', clientKey)
    ),
  ]);

  if (existing.length) {
    const { error } = await db
      .from('campaign_attribution')
      .delete()
      .eq('client_key', clientKey);
    if (error) throw error;
  }

  const sessionsByCustomer = new Map();
  for (const session of sessions) {
    if (!session.source_customer_id) continue;
    if (!sessionsByCustomer.has(session.source_customer_id)) sessionsByCustomer.set(session.source_customer_id, []);
    sessionsByCustomer.get(session.source_customer_id).push(session);
  }

  const seenCustomers = new Set();
  const rows = [];
  for (const appointment of appointments) {
    const candidates = sessionsByCustomer.get(appointment.source_customer_id) || [];
    const match = candidates.find((session) => withinWindow(session.first_outbound_at, appointment.source_created_at, config.attribution_days));
    if (!match) continue;

    const attended = ['CHECKED_IN', 'PAID'].includes(String(appointment.state || '').toUpperCase());
    const active = String(appointment.activation_state || '').toUpperCase() !== 'CANCELED';
    const unique = !seenCustomers.has(appointment.source_customer_id);
    const billable = Boolean(attended && active && unique);
    seenCustomers.add(appointment.source_customer_id);

    rows.push({
      client_key: clientKey,
      session_id: match.id,
      prospect_id: match.prospect_id,
      appointment_id: appointment.id,
      source_customer_id: appointment.source_customer_id,
      first_contact_at: match.first_outbound_at,
      appointment_created_at: appointment.source_created_at,
      appointment_date: appointment.appointment_date,
      attended_at: attended ? appointment.source_updated_at || new Date().toISOString() : null,
      within_attribution_window: true,
      unique_customer: unique,
      billable,
      rejection_reason: billable ? null : rejectionReason({ attended, active, unique }),
      raw_data: { session: match, appointment },
    });
  }

  if (rows.length) {
    const { error } = await db.from('campaign_attribution').insert(rows);
    if (error) throw error;
  }

  return {
    ok: true,
    client_key: clientKey,
    appointments_scanned: appointments.length,
    attribution_rows: rows.length,
    billable: rows.filter((row) => row.billable).length,
  };
}

function withinWindow(firstContactAt, appointmentCreatedAt, days) {
  const start = new Date(firstContactAt).getTime();
  const end = new Date(appointmentCreatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end >= start && end <= start + Number(days || 30) * 86400000;
}

function rejectionReason({ attended, active, unique }) {
  if (!active) return 'appointment_canceled';
  if (!attended) return 'not_attended';
  if (!unique) return 'duplicate_customer';
  return 'not_billable';
}

function normalizePhone(value) {
  let phone = String(value || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('0')) phone = `358${phone.slice(1)}`;
  return phone;
}

export default router;
