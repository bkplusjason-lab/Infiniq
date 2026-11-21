# Infiniq: sermon, lecture and meeting notes

Infiniq is a web app that records sermons, lectures and meetings, transcribes them, shows who spoke, estimates whether each voice is male or female, and turns the transcript into notes or formal minutes. It adjusts to phones, tablets and desktops and runs in current versions of Chrome, Edge, Safari and Firefox.

## Features

| Area | What it does |
|---|---|
| **Sign in** | Google, Facebook or WhatsApp (phone number + code sent on WhatsApp). |
| **Welcome email** | Sent once when an account is created, or when a WhatsApp user adds their email. |
| **6-digit code at every sign-in** | Sent to the user's email, or to WhatsApp for accounts that only have a phone number. The code expires after 10 minutes and allows 5 attempts. Codes are stored hashed, and resends are rate-limited. |
| **Recording** | One-tap recording with pause and resume, bookmarks for key moments, a sound-level meter, and a note pad while you listen. The screen stays awake during recording. |
| **Crash protection** | Audio is backed up on the device every second. If the tab closes, the library offers to recover the recording. |
| **Live transcript** | Shown as people speak in Chrome, Edge and Safari. 18 languages, including English variants, Mandarin, Malay, Indonesian, Tamil and Hindi. |
| **Speakers and voices** | Each speaker gets a label and a "male voice" or "female voice" estimate based on pitch. You can rename speakers ("Pastor John") and correct the estimate. With a transcription service configured, the service separates the speakers. |
| **Import** | Upload existing audio or video files (mp3, m4a, wav, mp4, and others). |
| **Playback** | Click any line to jump to that moment. The current line is highlighted, with speeds from 0.75× to 2× and 10-second skips. |
| **Editing** | Double-click any line to fix a word. You can move a line to another speaker. |
| **AI notes** (Claude) | Sermons: scriptures, main points, quotes, application, prayer points. Lectures: key concepts, detailed notes, review questions. Meetings: attendees, decisions, and an action-item table with owners. |
| **Library** | Search across titles, transcripts and notes. Filter by type, add tags, and see usage stats. |
| **Export** | Markdown, text, SRT/VTT subtitles, the original audio, Print or Save as PDF, and Share (on phones). |
| **🌐 Live Translation** (Pro plan) | Captions translated in real time while recording, plus a stand-alone **Live translate** screen. That screen has a *Listen* mode for sermons, lectures and music, and a two-way *Conversation* interpreter with read-aloud. You can also translate saved transcripts into 30+ languages, have sermon notes and meeting minutes written directly in your preferred language, translate your own notes, and export translated transcripts and subtitles. |
| **Account** | Edit your profile, see your plan and usage, sign out, and permanently delete your account and data. |
| **Installable** | Can be added to a phone's home screen (PWA manifest). Light and dark mode. |

## Run it locally

You need **Node.js 22.13 or newer**. There is no separate database server: Infiniq uses Node's built-in SQLite.

```bash
npm install
cp .env.example .env      # optional for a first test
npm start                 # http://localhost:3000
```

**Test mode.** Until you add real keys, the Google and Facebook buttons open a simulated sign-in form. Emails and WhatsApp messages are not sent. They appear at **http://localhost:3000/dev/outbox**, which is where you read the welcome email and the 6-digit codes. Test mode is switched off automatically when `NODE_ENV=production`.

Without a transcription key, the transcript comes from the browser's live captions. Speakers are then grouped by voice pitch, which is approximate.

## Plans

| | **Free** | **Plus: US$4/month** (US$36/year) | **Pro: US$8/month** (US$72/year) |
|---|---|---|---|
| Recording | 1 every 24 hours, up to 60 min each, 300 min a month | Unlimited (fair use: 30 h a month), up to 4 h each | Unlimited (fair use: 50 h a month), up to 4 h each |
| Transcript | Live browser transcript; AI speaker detection for imported files (60 min a month) | AI transcript with speakers | AI transcript with speakers |
| Male/female voice labels | ✓ | ✓ | ✓ |
| AI notes and minutes | 3 a month | Unlimited | Unlimited |
| Audio kept for | 1 month | 3 months | 12 months |
| Notes and transcripts kept for | 12 months | Until you delete them | Until you delete them |
| Export | Plain text | All formats | All formats |
| 🌐 Live translation | — | — | ✓ (15 hours a month) |

How the rules work:
- **Prices and limits** live in one file, `src/services/plans.js`. Change a number there and the Plans page, the limits and the emails all follow.
- **Limits are enforced on the server.** The browser also stops a recording automatically when the plan's limit is reached, with a warning 2 minutes before.
- **If a recording is refused** for going over a limit, it stays saved on the device, so the user can upgrade and then save it.
- **Usage is counted in a separate log,** so deleting a recording doesn't give back its minutes.
- **Monthly allowances reset on the 1st of each month (UTC).** The "1 every 24 hours" rule is counted from the last recording.
- **Automatic deletion** runs every hour. It emails a warning **7 days before** anything is deleted and shows warnings in the library and on the recording. When the **audio** expires, the transcript and notes are kept.
- **Changing plans:** upgrading extends how long data is kept straight away. Downgrading always leaves **at least 7 days** to export.

### Testing plans and translation

1. Sign in. A new account starts on **Free**, and the library shows your usage.
2. Make one recording. Trying a second one shows "Recording limit reached" with the time you can record again. Locked export formats open an upgrade pop-up.
3. Open **Account → Change plan** (or **See plans**). In test mode, the default outside production, the buttons switch plans instantly and take no payment. There's a Monthly/Yearly switch.
4. On **Pro**, try **🌐 Translate → Listen** (e.g. 日本語 Japanese → English), or **Conversation** mode with read-aloud. Also try **Record** with "Translate live to" ticked, then the recording's **🌐 Translate** tab.
5. To see deletion warnings without waiting a month, the automated tests (`test/plans.test.js`) backdate recordings and run the deletion job.

Without `ANTHROPIC_API_KEY`, translations are labelled demo text such as "[English – demo] …". This lets you test every screen and limit for free.

### Tests

```bash
npm test          # API and security tests: OTP, lockout, account merging, data isolation, export
npm run test:e2e  # real browser: sign in → record from a simulated mic → check voices → phone and desktop layouts
```

## Going live: keys to add to `.env`

| Feature | Where to get it | Settings |
|---|---|---|
| Google sign-in | Google Cloud Console → APIs & Services → Credentials → OAuth client (Web). Redirect URI: `https://YOUR-DOMAIN/auth/google/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Facebook login | developers.facebook.com → Create app → Facebook Login. Redirect URI: `https://YOUR-DOMAIN/auth/facebook/callback` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| WhatsApp codes | Meta WhatsApp Business Platform (Cloud API). Create an **Authentication** message template, e.g. `otp_code`, and get it approved. | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` |
| Official emails | Any SMTP service: Google Workspace, SendGrid, Mailgun, Amazon SES, and others. Send from your own domain with SPF/DKIM set up so emails don't land in spam. | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` |
| Speaker detection | AssemblyAI **or** Deepgram API key | `ASSEMBLYAI_API_KEY` or `DEEPGRAM_API_KEY` |
| AI notes + translation | console.anthropic.com | `ANTHROPIC_API_KEY` (optional: `CLAUDE_TRANSLATE_MODEL` for a faster live-caption model) |
| Plans | Prices and limits are set in `src/services/plans.js`. Turn off test mode once real payments are connected. | `PRICE_CURRENCY`, `BILLING_TEST_MODE=false` |

Also set `NODE_ENV=production`, `APP_URL=https://your-domain`, and a long random `SESSION_SECRET`. Serve the site over **HTTPS**, because browsers only allow microphone access on secure sites.

> **About "Login with WhatsApp":** WhatsApp has no "Sign in with WhatsApp" button like Google or Facebook. The standard approach, used here, is that the user enters their WhatsApp number and receives a 6-digit code on WhatsApp. That code proves they own the number and also serves as their sign-in code.

## How it is built

```
public/            Front end (plain HTML/CSS/JS, no build step)
  app.js           Screens: login, code entry, library, recorder, recording page, account
  recorder.js      Microphone, live captions, pitch tracking, backup on the device
  translate.js     Live Translation: language lists, live caption translator, conversation listener
  pitch.js         Voice pitch detection (YIN algorithm), used for the male/female estimate
src/
  server.js        Express server, security headers, CSRF check
  routes/auth.js   Google / Facebook / WhatsApp sign-in, codes, adding an email
  routes/recordings.js  Upload, transcript, speakers, notes, export, account
  routes/translate.js   Plans and billing (test mode), live translation, transcript/notes translation
  services/plans.js     Plan prices, limits, usage meter, storage periods
  services/retention.js Hourly deletion job and 7-day warning emails
  services/        Email, WhatsApp, transcription (AssemblyAI/Deepgram), voices, AI notes (Claude)
data/              SQLite database + audio files (created automatically, not committed)
```

**Security measures:** httpOnly cookies on every session; session and code values stored only as hashes; codes expire, lock after 5 wrong attempts, and are rate-limited; a CSRF header check; a strict Content-Security-Policy; each user can only reach their own recordings and audio; and a self-service option to delete the account.

**How the voice estimate works:** while recording, the browser measures the pitch of the voice ten times a second. Adult male voices are usually around 85–155 Hz and adult female voices around 165–255 Hz. The middle pitch of each speaker decides the label, shown with a confidence figure. Children, very deep female voices and very high male voices can be mislabelled, so users can always correct the label.

## Features you could add next

1. **Real payments.** Connect Stripe Checkout and Billing. A Stripe webhook only needs to call `setPlan(userId, 'plus' | 'pro' | 'free', 'month' | 'year')` in `src/routes/translate.js`. Every plan change is already logged in `billing_events`.
2. **Church and school plans.** For example, US$49 a month for a whole congregation or class, with shared recordings and translated sermons for every member.
3. **Local prices** in SGD or MYR (e.g. S$5 / S$10).
4. **Speaker voice profiles.** Remember "Pastor John's voice" so he is named automatically in future recordings.
5. **Ask your recordings.** For example, "What did the pastor say about forgiveness last month?", answered by Claude across your library.
6. **Shared workspaces.** A church, school or company team shares recordings and minutes, with roles for admin, editor and viewer.
7. **Email minutes to attendees** with one tap, and send action-item reminders.
8. **Calendar integration.** Name and tag meeting recordings automatically from Google or Outlook calendar events.
9. **Faster live translation.** Server-side streaming speech recognition (e.g. Deepgram live) would add Firefox support and translate mid-sentence. Text-to-speech in a natural voice could serve as a "church headset" interpretation channel that many listeners join with a QR code.
10. **Scripture lookup.** Link the Bible references found in sermons to the verse text.
11. **Highlight clips.** Share a 30-second audio clip with its caption on social media or WhatsApp.
12. **Offline mode.** Record with no internet connection and upload automatically when the connection returns.
13. **Cloud storage.** Move audio to S3, Google Cloud Storage or R2 to scale, and add automatic backups.
14. **Privacy and compliance.** A consent notice before recording others, plus data-retention settings for PDPA and GDPR.
15. **Admin dashboard.** Track users, usage, errors and revenue.
16. **Native mobile apps.** Wrap the web app with Capacitor to record reliably with the screen off.
