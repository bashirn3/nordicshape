import './lib/env.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import campaignsRouter from './routes/campaigns.js';
import settingsRouter from './routes/settings.js';
import chatsRouter from './routes/chats.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../client/dist');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const api = express.Router();
api.get('/health', (_req, res) => res.json({ ok: true }));
api.use('/campaigns', campaignsRouter);
api.use('/settings', settingsRouter);
api.use('/chats', chatsRouter);

app.use('/api', api);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[api] error', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

export default app;
