import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const DEFAULT_EU_BASE_URL = 'https://api-gateway-eu.phorest.com/third-party-api-server';
const DEFAULT_PAGE_SIZE = 100;

export class PhorestClient {
  constructor({
    baseURL = process.env.PHOREST_API_BASE_URL || DEFAULT_EU_BASE_URL,
    username = process.env.PHOREST_USERNAME,
    password = process.env.PHOREST_PASSWORD,
    businessId = process.env.PHOREST_BUSINESS_ID || 'gtVSxhw3-UD0Fwqkvj12Eg',
    branchId = process.env.PHOREST_BRANCH_ID || 'gQ0m3Eg_w8yIGQS-DtbfoQ',
    timeout = Number(process.env.PHOREST_TIMEOUT_MS || 60000),
  } = {}) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.businessId = businessId;
    this.branchId = branchId;
    this.http = axios.create({
      baseURL: this.baseURL,
      timeout,
      headers: { Accept: 'application/json' },
      auth: username && password ? { username, password } : undefined,
    });
  }

  assertConfigured() {
    const missing = [];
    if (!this.username) missing.push('PHOREST_USERNAME');
    if (!this.password) missing.push('PHOREST_PASSWORD');
    if (!this.businessId) missing.push('PHOREST_BUSINESS_ID');
    if (!this.branchId) missing.push('PHOREST_BRANCH_ID');
    if (missing.length) throw new Error(`Missing Phorest configuration: ${missing.join(', ')}`);
  }

  async get(path, params = {}) {
    this.assertConfigured();
    const { data } = await this.http.get(path, { params });
    return data;
  }

  async getPaged(path, { embeddedKey, params = {}, size = DEFAULT_PAGE_SIZE } = {}) {
    const rows = [];
    let page = 0;
    let totalPages = 1;

    do {
      const data = await this.get(path, { ...params, size, page });
      const embedded = data?._embedded || {};
      const batch = embeddedKey ? embedded[embeddedKey] : Object.values(embedded).find(Array.isArray);
      if (Array.isArray(batch)) rows.push(...batch);
      totalPages = Number(data?.page?.totalPages || 1);
      page += 1;
    } while (page < totalPages);

    return rows;
  }

  listBranches() {
    return this.get(`/api/business/${this.businessId}/branch`);
  }

  listClients({ updatedFrom, updatedTo, pageSize = DEFAULT_PAGE_SIZE } = {}) {
    return this.getPaged(`/api/business/${this.businessId}/client`, {
      embeddedKey: 'clients',
      size: pageSize,
      params: compactParams({
        updated_from: updatedFrom,
        updated_to: updatedTo,
        fetch_archived: false,
        fetch_deleted: false,
      }),
    });
  }

  listAppointments({
    branchId = this.branchId,
    fromDate,
    toDate,
    updatedFrom,
    updatedTo,
    clientId,
    pageSize = DEFAULT_PAGE_SIZE,
  } = {}) {
    return this.getPaged(`/api/business/${this.businessId}/branch/${branchId}/appointment`, {
      embeddedKey: 'appointments',
      size: pageSize,
      params: compactParams({
        from_date: fromDate,
        to_date: toDate,
        updated_from: updatedFrom,
        updated_to: updatedTo,
        client_id: clientId,
        fetch_canceled: true,
        fetch_deleted: true,
        fetch_archived: false,
        fetch_online_category: true,
      }),
    });
  }

  async smokeTest() {
    const branches = await this.listBranches();
    const branchRows = branches?._embedded?.branches || branches?.branches || [];
    return {
      ok: true,
      businessId: this.businessId,
      configuredBranchId: this.branchId,
      branchCount: branchRows.length,
      branches: branchRows.map((branch) => ({
        branchId: branch.branchId || branch.id,
        name: branch.name || branch.branchName || branch.title,
      })),
    };
  }
}

export function normalizePhone(value = '') {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `358${digits.slice(1)}`;
  return digits;
}

export function normalizeClient(client = {}, clientKey = process.env.CAMPAIGN_CLIENT_KEY || 'nordicshape') {
  return {
    client_key: clientKey,
    source_system: 'phorest',
    source_customer_id: client.clientId,
    first_name: client.firstName || '',
    last_name: client.lastName || '',
    email: client.email || '',
    phone: client.mobile || client.landLine || '',
    normalized_phone: normalizePhone(client.mobile || client.landLine || ''),
    sms_marketing_consent: Boolean(client.smsMarketingConsent),
    email_marketing_consent: Boolean(client.emailMarketingConsent),
    archived: Boolean(client.archived),
    deleted: Boolean(client.deleted),
    banned: Boolean(client.banned),
    customer_since: client.clientSince || null,
    source_updated_at: client.updatedAt || null,
    raw_data: client,
  };
}

export function normalizeAppointment(appointment = {}, clientKey = process.env.CAMPAIGN_CLIENT_KEY || 'nordicshape') {
  return {
    client_key: clientKey,
    source_system: 'phorest',
    source_appointment_id: appointment.appointmentId,
    source_booking_id: appointment.bookingId || null,
    source_customer_id: appointment.clientId || null,
    source_branch_id: appointment.branchId || process.env.PHOREST_BRANCH_ID || null,
    appointment_date: appointment.appointmentDate || null,
    start_time: appointment.startTime || null,
    service_name: appointment.serviceName || null,
    source: appointment.source || null,
    state: appointment.state || null,
    activation_state: appointment.activationState || null,
    deleted: Boolean(appointment.deleted),
    price: appointment.price ?? null,
    source_created_at: appointment.createdAt || null,
    source_updated_at: appointment.updatedAt || null,
    raw_data: appointment,
  };
}

function compactParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

async function main() {
  const mode = process.argv[2] || 'smoke';
  const client = new PhorestClient();
  const clientKey = process.env.CAMPAIGN_CLIENT_KEY || 'nordicshape';

  if (mode === 'smoke') {
    console.log(JSON.stringify(await client.smokeTest(), null, 2));
    return;
  }

  if (mode === 'clients') {
    const rows = await client.listClients({ pageSize: Number(process.argv[3] || 25) });
    console.log(JSON.stringify({ count: rows.length, sample: rows.slice(0, 3).map((row) => normalizeClient(row, clientKey)) }, null, 2));
    return;
  }

  if (mode === 'appointments') {
    const fromDate = process.argv[3] || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const toDate = process.argv[4] || new Date().toISOString().slice(0, 10);
    const rows = await client.listAppointments({ fromDate, toDate });
    console.log(JSON.stringify({ count: rows.length, sample: rows.slice(0, 3).map((row) => normalizeAppointment(row, clientKey)) }, null, 2));
    return;
  }

  throw new Error(`Unknown mode "${mode}". Use smoke, clients, or appointments.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({
      ok: false,
      status: err.response?.status,
      error: err.response?.data?.detail || err.response?.data?.message || err.message,
    }, null, 2));
    process.exitCode = 1;
  });
}
