import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, providers } from './config.js';
import { authRouter } from './routes/auth.js';
import { recRouter } from './routes/recordings.js';
import { listOutbox } from './services/outbox.js';
import { transcriptionAvailable } from './services/transcribe.js';
import { notesAvailable } from './services/notes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "img-src 'self' data: https:", "media-src 'self' blob:", "style-src 'self'",
      "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
    ].join('; '));
    if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));

  // CSRF protection: state-changing API calls must come from our own pages.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'infiniq') return res.status(403).json({ error: 'Bad request origin' });
    next();
  });

  app.get('/api/config', (req, res) => res.json({
    appName: config.appName,
    providers,
    devLogin: config.devLogin,
    serverTranscription: transcriptionAvailable(),
    aiNotes: notesAvailable(),
  }));

  app.use(authRouter);
  app.use(recRouter);

  if (config.devLogin) {
    app.get('/api/dev/outbox', (req, res) => res.json({ messages: listOutbox() }));
  }

  app.use(express.static(path.join(config.root, 'public'), { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));
  app.get('/dev/outbox', (req, res) => config.devLogin ? res.sendFile(path.join(config.root, 'public', 'outbox.html')) : res.status(404).end());

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large' });
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(config.port, () => {
    console.log(`${config.appName} running at ${config.appUrl}`);
    if (config.devLogin) console.log(`Dev outbox (emails & WhatsApp codes): ${config.appUrl}/dev/outbox`);
  });
}
