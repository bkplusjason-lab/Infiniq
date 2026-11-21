import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
if (fs.existsSync(path.join(root, '.env')) && !process.env.SKIP_DOTENV) {
  process.loadEnvFile(path.join(root, '.env'));
}

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const isProd = env('NODE_ENV') === 'production';

let sessionSecret = env('SESSION_SECRET');
if (!sessionSecret || sessionSecret === 'change-me') {
  if (isProd) throw new Error('SESSION_SECRET must be set in production');
  sessionSecret = 'dev-only-secret-' + crypto.createHash('sha256').update(root).digest('hex');
}

export const config = {
  root,
  isProd,
  appName: env('APP_NAME', 'Infiniq'),
  port: Number(env('PORT', '3000')),
  appUrl: env('APP_URL', `http://localhost:${env('PORT', '3000')}`).replace(/\/$/, ''),
  sessionSecret,
  sessionDays: Number(env('SESSION_DAYS', '7')),
  dataDir: env('DATA_DIR', path.join(root, 'data')),
  devLogin: !isProd && env('DEV_LOGIN', 'true') === 'true',
  google: { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') },
  facebook: { appId: env('FACEBOOK_APP_ID'), appSecret: env('FACEBOOK_APP_SECRET') },
  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    template: env('WHATSAPP_TEMPLATE_NAME', 'otp_code'),
    lang: env('WHATSAPP_TEMPLATE_LANG', 'en_US'),
  },
  smtp: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    secure: env('SMTP_SECURE') === 'true',
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('MAIL_FROM', 'Infiniq <no-reply@example.com>'),
  },
  transcription: {
    provider: env('TRANSCRIPTION_PROVIDER') ||
      (env('ASSEMBLYAI_API_KEY') ? 'assemblyai' : env('DEEPGRAM_API_KEY') ? 'deepgram' : ''),
    assemblyKey: env('ASSEMBLYAI_API_KEY'),
    deepgramKey: env('DEEPGRAM_API_KEY'),
  },
  billing: {
    // Lets users switch paid add-ons on/off without paying, for testing. Never enable in production.
    testMode: env('BILLING_TEST_MODE', isProd ? 'false' : 'true') === 'true',
    currency: env('PRICE_CURRENCY', 'US$'),
  },
  translation: {
    // claude | mock ("mock" returns labelled demo text so the flow can be tested without an AI key)
    provider: env('TRANSLATION_PROVIDER') || ((env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN')) ? 'claude' : (isProd ? '' : 'mock')),
    model: env('CLAUDE_TRANSLATE_MODEL', env('CLAUDE_MODEL', 'claude-opus-5-5')),
  },
  claude: { enabled: !!(env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN')), model: env('CLAUDE_MODEL', 'claude-opus-5-5') },
};

export const providers = {
  google: !!(config.google.clientId && config.google.clientSecret),
  facebook: !!(config.facebook.appId && config.facebook.appSecret),
  whatsapp: !!(config.whatsapp.token && config.whatsapp.phoneNumberId),
};

fs.mkdirSync(path.join(config.dataDir, 'audio'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'outbox'), { recursive: true });
