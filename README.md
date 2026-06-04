# Campaign Dashboard

Generic outbound campaign dashboard for WhatsApp reactivation clients.

The app uses shared `campaign_*` Supabase tables scoped by `client_key`. Nordicshape is currently configured as `client_key = 'nordicshape'`, but the schema is not client-specific.

## Setup

1. Apply `db/schema.sql` in Supabase.
2. Copy `.env.example` to `.env` and fill Supabase credentials.
3. Install and run:

```bash
npm install
npm install --prefix client
npm run dev
```

## Phorest

Phorest API access uses Basic Auth credentials issued by Phorest, not the normal UI PIN login.

Smoke test once credentials are available:

```bash
npm run phorest:smoke
```

## CSV Fallback

Client export:

```bash
npm run import:csv -- --type clients --file path/to/clients.csv
```

Appointment export:

```bash
npm run import:csv -- --type appointments --file path/to/appointments.csv
```

## Dashboard

Default route shows the configured `CAMPAIGN_CLIENT_KEY`, currently `nordicshape`.

Metrics:

- Eligible prospects
- Contacted
- Replied
- Opt-outs

Booked, attended, billable, and invoice metrics should only be enabled after appointment data is syncing reliably.
