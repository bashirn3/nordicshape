import { createClient } from '@supabase/supabase-js';
import { PhorestClient, normalizeAppointment, normalizePhone } from '../../scripts/phorest-client.js';

const DEFAULT_CLIENT_KEY = process.env.CAMPAIGN_CLIENT_KEY || 'nordicshape';
const DEFAULT_LOOKBACK_DAYS = 30;

export async function syncPhorestData({
  clientKey = DEFAULT_CLIENT_KEY,
  updatedFrom = defaultUpdatedFrom(),
  updatedTo = new Date().toISOString(),
  db = createDbClient(),
  phorest = new PhorestClient(),
} = {}) {
  const [prospects, sessions, appointments] = await Promise.all([
    fetchAll(() =>
      db
        .from('campaign_prospects')
        .select('id, normalized_phone, source_customer_id, raw_data')
        .eq('client_key', clientKey)
        .neq('source_system', 'manual_test'),
    ),
    fetchAll(() =>
      db
        .from('campaign_outbound_sessions')
        .select('id, number, source_customer_id')
        .eq('client_key', clientKey)
        .neq('source_system', 'manual_test'),
    ),
    phorest.listAppointments({ updatedFrom, updatedTo, pageSize: 100 }),
  ]);

  const phorestClients = await loadAppointmentClients(phorest, appointments);
  const clientsByPhone = buildClientsByPhone(phorestClients);

  const mappedProspects = await mapProspectsToPhorest(db, clientKey, prospects, clientsByPhone);
  const mappedSessions = await mapSessionsToPhorest(db, clientKey, sessions, clientsByPhone);
  const appointmentsSynced = await upsertAppointments(db, clientKey, appointments);
  const attribution = await recomputeAttribution(db, clientKey);

  return {
    ok: true,
    client_key: clientKey,
    appointment_clients_loaded: phorestClients.length,
    prospects_mapped_to_phorest: mappedProspects,
    sessions_mapped_to_phorest: mappedSessions,
    appointments_synced: appointmentsSynced,
    appointment_updated_window: { updatedFrom, updatedTo },
    attribution,
  };
}

function createDbClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient(url, key, { auth: { persistSession: false } });
}

function defaultUpdatedFrom() {
  if (process.env.PHOREST_SYNC_UPDATED_FROM) return process.env.PHOREST_SYNC_UPDATED_FROM;
  const lookbackDays = Number(process.env.PHOREST_SYNC_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS);
  return new Date(Date.now() - lookbackDays * 86400000).toISOString();
}

async function loadAppointmentClients(phorest, appointments) {
  const clientIds = [...new Set(appointments.map((appointment) => appointment.clientId).filter(Boolean))];
  const clients = [];
  await withConcurrency(clientIds, 8, async (clientId) => {
    const client = await phorest.get(`/api/business/${phorest.businessId}/client/${clientId}`);
    clients.push(client);
  });
  return clients;
}

function buildClientsByPhone(phorestClients) {
  const clientsByPhone = new Map();
  for (const client of phorestClients) {
    for (const phone of [client.mobile, client.landLine].map(normalizePhone).filter(Boolean)) {
      if (!clientsByPhone.has(phone)) clientsByPhone.set(phone, client);
    }
  }
  return clientsByPhone;
}

async function withConcurrency(items, limit, fn) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function fetchAll(queryFactory) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await queryFactory().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function mapProspectsToPhorest(db, clientKey, prospects, clientsByPhone) {
  let updated = 0;
  for (const prospect of prospects) {
    const phone = normalizePhone(prospect.normalized_phone);
    const phorestClient = phone ? clientsByPhone.get(phone) : null;
    if (!phorestClient?.clientId || prospect.source_customer_id === phorestClient.clientId) continue;

    const { error } = await db
      .from('campaign_prospects')
      .update({
        source_customer_id: phorestClient.clientId,
        raw_data: {
          ...(prospect.raw_data || {}),
          phorest_client: phorestClient,
          previous_source_customer_id: prospect.source_customer_id,
        },
      })
      .eq('client_key', clientKey)
      .eq('id', prospect.id);
    if (error) throw error;
    updated += 1;
  }
  return updated;
}

async function mapSessionsToPhorest(db, clientKey, sessions, clientsByPhone) {
  let updated = 0;
  for (const session of sessions) {
    const phorestClient = clientsByPhone.get(normalizePhone(session.number));
    if (!phorestClient?.clientId || session.source_customer_id === phorestClient.clientId) continue;

    const { error } = await db
      .from('campaign_outbound_sessions')
      .update({ source_customer_id: phorestClient.clientId })
      .eq('client_key', clientKey)
      .eq('id', session.id);
    if (error) throw error;
    updated += 1;
  }
  return updated;
}

async function upsertAppointments(db, clientKey, appointments) {
  const appointmentRows = appointments.map((appointment) => normalizeAppointment(appointment, clientKey));
  if (!appointmentRows.length) return 0;

  const { error } = await db
    .from('campaign_appointments')
    .upsert(appointmentRows, { onConflict: 'client_key,source_appointment_id' });
  if (error) throw error;
  return appointmentRows.length;
}

async function recomputeAttribution(db, clientKey) {
  const { data, error } = await db.rpc('recompute_campaign_attribution', { target_client_key: clientKey });
  if (!error) return data;

  if (!String(error.message || '').includes('recompute_campaign_attribution')) {
    throw error;
  }

  return recomputeAttributionInScript(db, clientKey);
}

async function recomputeAttributionInScript(db, clientKey) {
  const [{ data: config, error: configError }, sessions, appointments] = await Promise.all([
    db.from('campaign_client_config').select('attribution_days').eq('client_key', clientKey).maybeSingle(),
    fetchAll(() =>
      db
        .from('campaign_outbound_sessions')
        .select('*')
        .eq('client_key', clientKey)
        .neq('source_system', 'manual_test')
        .order('first_outbound_at', { ascending: true }),
    ),
    fetchAll(() =>
      db
        .from('campaign_appointments')
        .select('*')
        .eq('client_key', clientKey)
        .eq('deleted', false)
        .order('source_created_at', { ascending: true }),
    ),
  ]);
  if (configError) throw configError;

  const deleteRes = await db.from('campaign_attribution').delete().eq('client_key', clientKey);
  if (deleteRes.error) throw deleteRes.error;

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
    const match = candidates.find((session) =>
      withinWindow(session.first_outbound_at, appointment.source_created_at, config?.attribution_days || 30),
    );
    if (!match) continue;

    const attended = ['CHECKED_IN', 'PAID'].includes(String(appointment.state || '').toUpperCase());
    const active = String(appointment.activation_state || '').toUpperCase() !== 'CANCELED';
    const unique = !seenCustomers.has(appointment.source_customer_id);
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
      billable: Boolean(attended && active && unique),
      rejection_reason: rejectionReason({ attended, active, unique }),
      raw_data: { session: match, appointment },
    });
  }

  if (rows.length) {
    const { error } = await db.from('campaign_attribution').insert(rows);
    if (error) throw error;
  }

  return {
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
  return null;
}
