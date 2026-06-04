import './lib/env.js';
import express from 'express';
import cors from 'cors';
import campaignsRouter from './routes/campaigns.js';
import settingsRouter from './routes/settings.js';
import chatsRouter from './routes/chats.js';

const app = express();

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
app.use('/', api);

app.use((err, _req, res, _next) => {
  console.error('[api] error', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

export default app;
