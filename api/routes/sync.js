import { Router } from 'express';
import { syncPhorestData } from '../lib/phorest-sync.js';

const router = Router();

router.get('/phorest', handlePhorestSync);
router.get('/phorest/:clientKey', handlePhorestSync);
router.post('/phorest', handlePhorestSync);
router.post('/phorest/:clientKey', handlePhorestSync);

async function handlePhorestSync(req, res, next) {
  try {
    assertAuthorized(req);

    const clientKey = req.params.clientKey || req.query.client_key || process.env.CAMPAIGN_CLIENT_KEY || 'nordicshape';
    const result = await syncPhorestData({
      clientKey,
      updatedFrom: req.query.updated_from,
      updatedTo: req.query.updated_to,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

function assertAuthorized(req) {
  const secret = process.env.CRON_SECRET || process.env.SYNC_SECRET;
  if (!secret && process.env.VERCEL) {
    const err = new Error('CRON_SECRET or SYNC_SECRET is required in production');
    err.status = 500;
    throw err;
  }
  if (!secret) return;

  const authorization = req.get('authorization') || '';
  const syncSecret = req.get('x-sync-secret') || '';
  if (authorization === `Bearer ${secret}` || syncSecret === secret) return;

  const err = new Error('unauthorized');
  err.status = 401;
  throw err;
}

export default router;
