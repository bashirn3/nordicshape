import dotenv from 'dotenv';
import { syncPhorestData } from '../api/lib/phorest-sync.js';

dotenv.config();

const DEFAULT_CLIENT_KEY = process.env.CAMPAIGN_CLIENT_KEY || 'nordicshape';
const DEFAULT_UPDATED_FROM = '2026-06-01T00:00:00.000Z';

async function main() {
  const clientKey = process.argv[2] || DEFAULT_CLIENT_KEY;
  const updatedFrom = process.argv[3] || DEFAULT_UPDATED_FROM;
  const updatedTo = process.argv[4] || new Date().toISOString();

  const result = await syncPhorestData({ clientKey, updatedFrom, updatedTo });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    status: err.response?.status,
    error: err.response?.data?.detail || err.response?.data?.message || err.message,
  }, null, 2));
  process.exitCode = 1;
});
