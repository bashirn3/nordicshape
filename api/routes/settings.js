import { Router } from 'express';
import { requireSupabase } from '../lib/supabase.js';

const router = Router();

router.get('/:clientKey', async (req, res, next) => {
  try {
    const db = requireSupabase();
    const { data, error } = await db
      .from('campaign_client_config')
      .select('*')
      .eq('client_key', req.params.clientKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'client not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.put('/:clientKey', async (req, res, next) => {
  try {
    const updates = pickAllowed(req.body || {});
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no valid settings supplied' });

    const db = requireSupabase();
    const { data, error } = await db
      .from('campaign_client_config')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('client_key', req.params.clientKey)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'client not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

function pickAllowed(body) {
  const out = {};
  if (typeof body.outbound_enabled === 'boolean') out.outbound_enabled = body.outbound_enabled;
  if (body.daily_cap !== undefined) out.daily_cap = boundedInt(body.daily_cap, 1, 500, 'daily_cap');
  if (body.inactivity_months !== undefined) out.inactivity_months = boundedInt(body.inactivity_months, 1, 24, 'inactivity_months');
  if (body.attribution_days !== undefined) out.attribution_days = boundedInt(body.attribution_days, 1, 180, 'attribution_days');
  if (body.fee_per_billable_cents !== undefined) {
    out.fee_per_billable_cents = boundedInt(body.fee_per_billable_cents, 0, 100000, 'fee_per_billable_cents');
  }
  return out;
}

function boundedInt(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

export default router;
