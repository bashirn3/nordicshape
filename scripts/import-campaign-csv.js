import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { normalizePhone } from './phorest-client.js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const CLIENT_KEY = process.env.CAMPAIGN_CLIENT_KEY || 'nordicshape';
const BATCH_SIZE = 500;

async function main() {
  const mode = argValue('--type') || 'clients';
  const file = argValue('--file') || process.argv[2];
  if (!file) throw new Error('Usage: npm run import:csv -- --type clients|appointments --file export.csv');
  if (!['clients', 'appointments'].includes(mode)) throw new Error('--type must be clients or appointments');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

  const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  const records = rows.map(mode === 'clients' ? mapClientRow : mapAppointmentRow).filter(Boolean);
  const table = mode === 'clients' ? 'campaign_prospects' : 'campaign_appointments';
  const onConflict = mode === 'clients' ? 'client_key,source_customer_id' : 'client_key,source_appointment_id';

  let imported = 0;
  for (const batch of chunks(records, BATCH_SIZE)) {
    await supabaseUpsert(table, onConflict, batch);
    imported += batch.length;
  }

  console.log(JSON.stringify({
    ok: true,
    client_key: CLIENT_KEY,
    type: mode,
    rows: rows.length,
    imported,
    skipped: rows.length - records.length,
  }, null, 2));
}

function mapClientRow(row) {
  const phone = pick(row, ['mobile', 'phone', 'telephone', 'client phone', 'client mobile', 'number']);
  const normalized = normalizePhone(phone);
  const email = pick(row, ['email', 'client email', 'e-mail']);
  const sourceId = pick(row, ['clientid', 'client id', 'phorest client id', 'id']) || stableCsvId(normalized, email);
  if (!sourceId) return null;

  const smsConsent = truthy(pick(row, ['smsmarketingconsent', 'sms marketing consent', 'marketing sms', 'sms consent', 'marketing consent']));
  const emailConsent = truthy(pick(row, ['emailmarketingconsent', 'email marketing consent', 'marketing email', 'email consent']));
  const archived = truthy(pick(row, ['archived']));
  const deleted = truthy(pick(row, ['deleted']));
  const banned = truthy(pick(row, ['banned']));
  const lastAppointmentAt = parseDate(pick(row, ['last appointment', 'last appointment date', 'last visit', 'last visit date', 'last seen']));
  const hasMarketingConsent = smsConsent || emailConsent;
  const eligible = Boolean(normalized && hasMarketingConsent && !archived && !deleted && !banned && isInactive(lastAppointmentAt));

  return {
    client_key: CLIENT_KEY,
    source_system: 'phorest',
    source_customer_id: sourceId,
    first_name: pick(row, ['firstname', 'first name', 'client first name']),
    last_name: pick(row, ['lastname', 'last name', 'surname', 'client last name']),
    email,
    phone,
    normalized_phone: normalized,
    sms_marketing_consent: smsConsent,
    email_marketing_consent: emailConsent,
    archived,
    deleted,
    banned,
    customer_since: parseDate(pick(row, ['clientsince', 'client since', 'created at', 'createdat'])),
    source_updated_at: parseDate(pick(row, ['updatedat', 'updated at'])),
    last_appointment_at: lastAppointmentAt,
    eligible,
    ineligible_reason: eligible ? null : ineligibleReason({ normalized, hasMarketingConsent, archived, deleted, banned, lastAppointmentAt }),
    raw_data: row,
    updated_at: new Date().toISOString(),
  };
}

function mapAppointmentRow(row) {
  const sourceCustomerId = pick(row, ['clientid', 'client id', 'phorest client id']);
  const appointmentDate = parseDateOnly(pick(row, ['appointmentdate', 'appointment date', 'date']));
  const startTime = pick(row, ['starttime', 'start time', 'time']);
  const serviceName = pick(row, ['servicename', 'service name', 'service']);
  const appointmentId =
    pick(row, ['appointmentid', 'appointment id', 'id']) ||
    ['csv', sourceCustomerId, appointmentDate, startTime, serviceName].filter(Boolean).join(':');
  if (!appointmentId) return null;

  return {
    client_key: CLIENT_KEY,
    source_system: 'phorest',
    source_appointment_id: appointmentId,
    source_booking_id: pick(row, ['bookingid', 'booking id']),
    source_customer_id: sourceCustomerId || null,
    source_branch_id: pick(row, ['branchid', 'branch id']) || process.env.PHOREST_BRANCH_ID || null,
    appointment_date: appointmentDate,
    start_time: startTime || null,
    service_name: serviceName,
    source: pick(row, ['source']),
    state: normalizeState(pick(row, ['state', 'status', 'appointment state'])),
    activation_state: normalizeState(pick(row, ['activationstate', 'activation state', 'booking status'])),
    deleted: truthy(pick(row, ['deleted'])),
    price: numericOrNull(pick(row, ['price', 'amount'])),
    source_created_at: parseDate(pick(row, ['createdat', 'created at', 'booking created', 'booking created at'])),
    source_updated_at: parseDate(pick(row, ['updatedat', 'updated at'])),
    raw_data: row,
    synced_at: new Date().toISOString(),
  };
}

async function supabaseUpsert(table, onConflict, rows) {
  const url = new URL(`/rest/v1/${table}`, SUPABASE_URL);
  url.searchParams.set('on_conflict', onConflict);
  await axios.post(url.toString(), rows, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    timeout: 60000,
  });
}

function parseCsv(input) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1)
    .filter((values) => values.some((value) => String(value || '').trim()))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || '').trim()])));
}

function pick(row, aliases) {
  for (const alias of aliases) {
    const key = normalizeHeader(alias);
    if (row[key]) return row[key];
  }
  return '';
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function truthy(value) {
  return ['true', 'yes', 'y', '1', 'ok', 'allowed', 'consented'].includes(String(value || '').trim().toLowerCase());
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDateOnly(value) {
  const date = parseDate(value);
  return date ? date.slice(0, 10) : null;
}

function numericOrNull(value) {
  if (!value) return null;
  const number = Number(String(value).replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function normalizeState(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '_') || null;
}

function stableCsvId(normalizedPhone, email) {
  if (normalizedPhone) return `csv-phone:${normalizedPhone}`;
  if (email) return `csv-email:${email.toLowerCase()}`;
  return '';
}

function isInactive(lastAppointmentAt) {
  if (!lastAppointmentAt) return true;
  const months = Number(process.env.CAMPAIGN_INACTIVITY_MONTHS || 3);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return new Date(lastAppointmentAt).getTime() < cutoff.getTime();
}

function ineligibleReason({ normalized, hasMarketingConsent, archived, deleted, banned, lastAppointmentAt }) {
  if (!normalized) return 'missing_phone';
  if (!hasMarketingConsent) return 'missing_marketing_consent';
  if (archived) return 'archived';
  if (deleted) return 'deleted';
  if (banned) return 'banned';
  if (!isInactive(lastAppointmentAt)) return 'recent_engagement';
  return 'unknown';
}

function chunks(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.response?.data?.message || err.response?.data?.detail || err.message }, null, 2));
  process.exitCode = 1;
});
