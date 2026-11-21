#!/usr/bin/env node
/**
 * Ekkala Thoni Ministries — WhatsApp auto-reply webhook server.
 *
 * What it does:
 *  - Verifies Meta's webhook (GET /webhook).
 *  - Receives 1:1 incoming messages (POST /webhook): text + voice/audio.
 *  - Voice: downloads the audio, transcribes it locally with faster-whisper.
 *  - Classifies the text as prayer request, offering, or joining
 *    (new member wanting to join — see classify.js).
 *  - Sends back the matching template IMAGE via the WhatsApp Cloud API.
 *  - If unclear, asks "Prayer request-a, Offering-a, illa Joining-a?
 *    1 / 2 / 3" (the "3" option appears only once the joining template
 *    file exists) and answers "1" with the prayer image, "2" with the
 *    offering image, "3" with the joining image.
 *  - Joining template not sent yet: joining messages are logged
 *    (event 'joining_no_template') and NOT auto-replied until Sujitha
 *    sends joining-welcome.jpg. No welcome wording is invented.
 *  - Logs every message, classification and reply to logs/replies.log.
 *
 * It NEVER touches groups: it only replies to 1:1 messages that arrive
 * at this webhook. It sends no daily reminders.
 *
 * Configuration (environment variables, or a `.env` file in this folder):
 *  WHATSAPP_PHONE_NUMBER_ID  Meta phone number ID (from Meta setup)
 *  WHATSAPP_ACCESS_TOKEN     Permanent access token (from Meta setup)
 *  WHATSAPP_VERIFY_TOKEN     Any secret string you choose; must match the
 *                            verify token entered in Meta's webhook setup
 *  PORT                      Port to listen on (default 3000)
 *  TEMPLATES_DIR             Folder with offering-thanks.jpg and
 *                            prayer-request.jpg
 *                            (default: ~/workspace/your_files/whatsapp-auto-reply-templates)
 *  WHISPER_MODEL             faster-whisper model: tiny (default) | base | small
 *  DRY_RUN                   Set to "1" to classify + log but NOT send
 *                            anything to Meta (for local testing without
 *                            credentials). Default: "1" when the token or
 *                            phone number ID is missing.
 *
 * Run:  node server.js        (loads .env if present)
 * The server needs a PUBLIC https URL for Meta's webhook — see SETUP.md.
 * Local testing without Meta: use the test-classifier.js script, or POST a
 * sample payload to /webhook with DRY_RUN=1.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { classify } = require('./classify');

// ---- load .env (simple parser, no dependency) ----
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'ekkala-thoni-verify';
const TEMPLATES_DIR = process.env.TEMPLATES_DIR ||
  path.join(process.env.HOME || '', 'workspace', 'your_files', 'whatsapp-auto-reply-templates');
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'tiny';
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'replies.log');
const PENDING_FILE = path.join(__dirname, 'pending.json');
const DRY_RUN = process.env.DRY_RUN === '1' || !PHONE_NUMBER_ID || !ACCESS_TOKEN;

const CLARIFY_TEXT_2 =
  'Prayer request-a, illa Offering-a? 1 nu anupunga prayer ku, 2 nu anupunga offering ku.';
const CLARIFY_TEXT_3 =
  'Prayer request-a, Offering-a, illa Joining-a? 1 nu anupunga prayer ku, 2 nu anupunga offering ku, 3 nu anupunga joining ku.';

// The clarification question offers "3" for joining only when the joining
// template file exists. Until Sujitha sends it, the question stays 1 / 2.
function clarifyText() {
  return fs.existsSync(TEMPLATES.joining) ? CLARIFY_TEXT_3 : CLARIFY_TEXT_2;
}

const TEMPLATES = {
  prayer: path.join(TEMPLATES_DIR, 'prayer-request.jpg'),
  offering: path.join(TEMPLATES_DIR, 'offering-thanks.jpg'),
  // Joining welcome template — NOT sent yet by Sujitha. When she sends it,
  // save it as joining-welcome.jpg in TEMPLATES_DIR; no code change needed.
  // Until then, joining messages are logged (event 'joining_no_template')
  // and NOT auto-replied, so Sujitha can reply manually. The welcome
  // wording is never invented here.
  joining: path.join(TEMPLATES_DIR, 'joining-welcome.jpg'),
};

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---- logging ----
function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

// ---- pending clarification state (survives restarts) ----
function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return {}; }
}
function savePending(p) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(p, null, 2));
}

// ---- Meta Graph API helpers ----
const GRAPH = 'https://graph.facebook.com/v20.0';

async function graphJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`Meta ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

async function uploadImage(imagePath) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([fs.readFileSync(imagePath)], { type: 'image/jpeg' }), path.basename(imagePath));
  const body = await graphJson(
    `${GRAPH}/${PHONE_NUMBER_ID}/media`,
    { method: 'POST', headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, body: form }
  );
  return body.id; // media id
}

async function sendImage(to, imagePath) {
  const mediaId = await uploadImage(imagePath);
  const body = await graphJson(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: { id: mediaId },
      }),
    }
  );
  return body.messages && body.messages[0] ? body.messages[0].id : JSON.stringify(body);
}

async function sendText(to, text) {
  const body = await graphJson(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    }
  );
  return body.messages && body.messages[0] ? body.messages[0].id : JSON.stringify(body);
}

// ---- audio download + transcription ----
async function downloadMedia(mediaId) {
  const meta = await graphJson(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const url = meta.url;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!res.ok) throw new Error(`media download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (meta.mime_type || 'audio/ogg').split('/')[1].replace('opus', 'ogg');
  const file = path.join('/tmp', `wa-audio-${mediaId}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

function transcribeAudio(filePath) {
  return new Promise((resolve) => {
    const py = path.join(__dirname, 'venv', 'bin', 'python');
    execFile(py, [path.join(__dirname, 'transcribe.py'), filePath, WHISPER_MODEL],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { log({ event: 'transcribe_error', error: String(err).slice(0, 300) }); return resolve(''); }
        resolve((stdout || '').trim());
      });
  });
}

// ---- message handling ----
async function replyWithTemplate(to, kind, via) {
  const imagePath = TEMPLATES[kind];
  if (!fs.existsSync(imagePath)) {
    log({ event: 'template_missing', kind, imagePath });
    return { sent: false, reason: 'template image missing: ' + imagePath };
  }
  if (DRY_RUN) {
    log({ event: 'dry_run_send', to, kind, imagePath, via });
    return { sent: false, dryRun: true, kind };
  }
  const messageId = await sendImage(to, imagePath);
  log({ event: 'reply_sent', to, kind, imagePath, messageId, via });
  return { sent: true, kind, messageId };
}

async function handleMessage(msg) {
  const from = msg.from; // sender wa_id
  const messageId = msg.id;
  const type = msg.type;

  let text = '';
  let source = type;

  if (type === 'text') {
    text = (msg.text && msg.text.body) || '';
  } else if (type === 'audio') {
    if (DRY_RUN) {
      text = '';
      source = 'audio (dry-run: no download without credentials)';
      log({ event: 'audio_dry_run', from, messageId, mediaId: msg.audio && msg.audio.id });
    } else {
      try {
        const file = await downloadMedia(msg.audio.id);
        text = await transcribeAudio(file);
        source = 'audio -> transcribed';
        try { fs.unlinkSync(file); } catch { /* ignore */ }
      } catch (e) {
        log({ event: 'audio_error', from, messageId, error: String(e).slice(0, 300) });
        text = '';
      }
    }
  } else {
    log({ event: 'ignored_type', from, messageId, type });
    return;
  }

  log({ event: 'incoming', from, messageId, source, text: text.slice(0, 500) });

  const pending = loadPending();
  const result = classify(text);

  // Answer to the clarification question takes priority.
  if ((result.kind === 'choice-1' || result.kind === 'choice-2' || result.kind === 'choice-3') && pending[from]) {
    const kind = result.kind === 'choice-1' ? 'prayer' : result.kind === 'choice-2' ? 'offering' : 'joining';
    delete pending[from];
    savePending(pending);
    if (kind === 'joining' && !fs.existsSync(TEMPLATES.joining)) {
      log({ event: 'joining_no_template', from, messageId, note: 'member answered 3 but no joining template file yet' });
      return;
    }
    await replyWithTemplate(from, kind, 'clarification-answer');
    return;
  }

  if (result.kind === 'prayer' || result.kind === 'offering' || result.kind === 'joining') {
    if (pending[from]) { delete pending[from]; savePending(pending); }
    if (result.kind === 'joining' && !fs.existsSync(TEMPLATES.joining)) {
      // Template not sent yet — log prominently, do NOT send a wrong image
      // and do NOT invent welcome wording. Sujitha replies manually.
      log({ event: 'joining_no_template', from, messageId, text: text.slice(0, 200), reason: result.reason });
      return;
    }
    await replyWithTemplate(from, result.kind, result.reason);
    return;
  }

  // Unclear (including empty transcription): ask which one it is.
  pending[from] = { askedAt: new Date().toISOString(), text: text.slice(0, 200) };
  savePending(pending);
  const clarify = clarifyText();
  if (DRY_RUN) {
    log({ event: 'dry_run_send_text', to: from, text: clarify, reason: result.reason });
  } else {
    try {
      const id = await sendText(from, clarify);
      log({ event: 'clarify_sent', to: from, messageId: id, reason: result.reason });
    } catch (e) {
      log({ event: 'clarify_error', to: from, error: String(e).slice(0, 300) });
    }
  }
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/webhook') {
    // Meta verification: hub.mode=subscribe & hub.verify_token & hub.challenge
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge || '');
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('verify token mismatch');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // Ack fast (Meta wants <20s); process in the background.
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('EVENT_RECEIVED');
      let payload;
      try { payload = JSON.parse(body); } catch { return; }
      const entries = payload.entry || [];
      for (const entry of entries) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          for (const msg of value.messages || []) {
            handleMessage(msg).catch((e) =>
              log({ event: 'handle_error', from: msg.from, error: String(e).slice(0, 300) }));
          }
        }
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      dryRun: DRY_RUN,
      templates: {
        prayer: fs.existsSync(TEMPLATES.prayer),
        offering: fs.existsSync(TEMPLATES.offering),
        joining: fs.existsSync(TEMPLATES.joining),
      },
      verifyTokenSet: VERIFY_TOKEN !== 'ekkala-thoni-verify',
      credentialsPresent: Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Ekkala Thoni WhatsApp auto-reply listening on port ${PORT}`);
  console.log(`DRY_RUN=${DRY_RUN} (no Meta credentials => classify + log only)`);
  console.log(`Templates: prayer=${TEMPLATES.prayer} (${fs.existsSync(TEMPLATES.prayer) ? 'found' : 'MISSING'})`);
  console.log(`           offering=${TEMPLATES.offering} (${fs.existsSync(TEMPLATES.offering) ? 'found' : 'MISSING'})`);
  console.log(`           joining=${TEMPLATES.joining} (${fs.existsSync(TEMPLATES.joining) ? 'found' : 'NOT SENT YET — joining messages will be logged, not auto-replied'})`);
  console.log(`Verify token: ${VERIFY_TOKEN === 'ekkala-thoni-verify' ? 'DEFAULT — set WHATSAPP_VERIFY_TOKEN in .env' : 'set'}`);
  console.log(`Log file: ${LOG_FILE}`);
});
