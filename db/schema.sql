-- Shared campaign schema.
--
-- One set of tables supports many outbound clients. Each row is scoped by
-- client_key, for example 'nordicshape'.

create table if not exists public.campaign_client_config (
  client_key text primary key,
  display_name text not null,
  outbound_enabled boolean not null default false,
  daily_cap integer not null default 20 check (daily_cap between 1 and 500),
  inactivity_months integer not null default 3 check (inactivity_months between 1 and 24),
  attribution_days integer not null default 30 check (attribution_days between 1 and 180),
  fee_per_billable_cents integer not null default 1500 check (fee_per_billable_cents >= 0),
  campaign_name text not null,
  source_system text not null default 'phorest',
  updated_at timestamptz not null default now()
);

insert into public.campaign_client_config (
  client_key,
  display_name,
  campaign_name,
  source_system
)
values (
  'nordicshape',
  'Nordicshape',
  'nordicshape-reactivation',
  'phorest'
)
on conflict (client_key) do nothing;

create table if not exists public.campaign_prospects (
  id bigserial primary key,
  client_key text not null references public.campaign_client_config(client_key) on delete cascade,
  source_system text not null default 'phorest',
  source_customer_id text,
  first_name text,
  last_name text,
  email text,
  phone text,
  normalized_phone text,
  sms_marketing_consent boolean,
  email_marketing_consent boolean,
  archived boolean not null default false,
  deleted boolean not null default false,
  banned boolean not null default false,
  customer_since timestamptz,
  source_updated_at timestamptz,
  last_appointment_at timestamptz,
  eligible boolean not null default false,
  ineligible_reason text,
  status text not null default 'pending'
    check (status in ('pending', 'contacted', 'replied', 'booked', 'attended', 'opted_out', 'rejected')),
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists campaign_prospects_source_customer_idx
  on public.campaign_prospects (client_key, source_customer_id)
  where source_customer_id is not null and source_customer_id <> '';

create unique index if not exists campaign_prospects_phone_idx
  on public.campaign_prospects (client_key, normalized_phone)
  where normalized_phone is not null and normalized_phone <> '';

create index if not exists campaign_prospects_status_idx
  on public.campaign_prospects (client_key, status, eligible, updated_at);

create table if not exists public.campaign_outbound_sessions (
  id bigserial primary key,
  client_key text not null references public.campaign_client_config(client_key) on delete cascade,
  prospect_id bigint references public.campaign_prospects(id) on delete set null,
  source_system text not null default 'phorest',
  source_customer_id text,
  campaign_name text not null,
  number text not null,
  email text,
  first_outbound_at timestamptz not null default now(),
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  outbound_count integer not null default 0,
  inbound_count integer not null default 0,
  provider_message_id text,
  stop_reminders boolean not null default false,
  stop_reason text,
  opt_out_at timestamptz,
  booked_at timestamptz,
  attended_at timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_outbound_sessions_number_idx
  on public.campaign_outbound_sessions (client_key, number);

create index if not exists campaign_outbound_sessions_contacted_idx
  on public.campaign_outbound_sessions (client_key, first_outbound_at, campaign_name);

create table if not exists public.campaign_message_status (
  id bigserial primary key,
  client_key text not null references public.campaign_client_config(client_key) on delete cascade,
  number text,
  provider_message_id text,
  provider text not null default 'wasup',
  status text not null,
  occurred_at timestamptz not null default now(),
  raw_event jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists campaign_message_status_number_idx
  on public.campaign_message_status (client_key, number, status);

create unique index if not exists campaign_message_status_unique_idx
  on public.campaign_message_status (client_key, provider_message_id, status)
  where provider_message_id is not null and provider_message_id <> '';

create table if not exists public.campaign_appointments (
  id bigserial primary key,
  client_key text not null references public.campaign_client_config(client_key) on delete cascade,
  source_system text not null default 'phorest',
  source_appointment_id text not null,
  source_booking_id text,
  source_customer_id text,
  source_branch_id text,
  appointment_date date,
  start_time time,
  service_name text,
  source text,
  state text,
  activation_state text,
  deleted boolean not null default false,
  price numeric,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);

create unique index if not exists campaign_appointments_source_idx
  on public.campaign_appointments (client_key, source_appointment_id);

create index if not exists campaign_appointments_customer_idx
  on public.campaign_appointments (client_key, source_customer_id, source_created_at);

create index if not exists campaign_appointments_state_idx
  on public.campaign_appointments (client_key, activation_state, state, appointment_date);

create table if not exists public.campaign_attribution (
  id bigserial primary key,
  client_key text not null references public.campaign_client_config(client_key) on delete cascade,
  session_id bigint references public.campaign_outbound_sessions(id) on delete cascade,
  prospect_id bigint references public.campaign_prospects(id) on delete set null,
  appointment_id bigint references public.campaign_appointments(id) on delete set null,
  source_customer_id text,
  first_contact_at timestamptz,
  appointment_created_at timestamptz,
  appointment_date date,
  attended_at timestamptz,
  within_attribution_window boolean not null default false,
  unique_customer boolean not null default true,
  billable boolean not null default false,
  rejection_reason text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists campaign_attribution_appointment_idx
  on public.campaign_attribution (client_key, appointment_id)
  where appointment_id is not null;

create index if not exists campaign_attribution_billable_idx
  on public.campaign_attribution (client_key, billable, appointment_date);

create or replace view public.campaign_dashboard_summary as
select
  c.client_key,
  c.display_name,
  count(distinct p.id) filter (where p.eligible and p.status = 'pending') as eligible_prospects,
  count(distinct s.id) as contacted,
  count(distinct s.id) filter (where s.last_inbound_at is not null) as replied,
  count(distinct a.id) filter (where a.appointment_id is not null) as booked,
  count(distinct a.id) filter (where a.attended_at is not null) as attended,
  count(distinct a.id) filter (where a.billable) as billable,
  coalesce(sum(c.fee_per_billable_cents) filter (where a.billable), 0) as billable_cents
from public.campaign_client_config c
left join public.campaign_prospects p on p.client_key = c.client_key
left join public.campaign_outbound_sessions s on s.client_key = c.client_key
left join public.campaign_attribution a on a.session_id = s.id and a.client_key = c.client_key
group by c.client_key, c.display_name;

create or replace view public.campaign_billing_report as
select
  a.client_key,
  a.id as attribution_id,
  a.billable,
  a.rejection_reason,
  a.first_contact_at,
  a.appointment_created_at,
  a.appointment_date,
  a.attended_at,
  p.source_customer_id,
  p.first_name,
  p.last_name,
  p.email,
  p.normalized_phone,
  ap.source_appointment_id,
  ap.source_booking_id,
  ap.service_name,
  ap.state,
  ap.activation_state,
  case when a.billable then c.fee_per_billable_cents else 0 end as fee_cents
from public.campaign_attribution a
left join public.campaign_prospects p on p.id = a.prospect_id
left join public.campaign_appointments ap on ap.id = a.appointment_id
join public.campaign_client_config c on c.client_key = a.client_key;
