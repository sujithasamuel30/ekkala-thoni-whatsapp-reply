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
 *  - Replies are DELAYED: they go out 2 hours after the member messages
 *    (REPLY_DELAY_HOURS, default 2), not immediately — Sujitha, 2026-11-21.
 *    Queued in pending-replies.json, so a restart doesn't lose them.
 *    Well inside WhatsApp's 24-hour service window.
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
const REPLIES_FILE = path.join(__dirname, 'pending-replies.json');
const DRY_RUN = process.env.DRY_RUN === '1' || !PHONE_NUMBER_ID || !ACCESS_TOKEN;
// Reply delay: the auto-reply goes out this long AFTER the member messages,
// not immediately (Sujitha, 2026-11-21 — "two hours"). Change with
// REPLY_DELAY_HOURS. Well inside WhatsApp's 24-hour service window.
const REPLY_DELAY_MS = (parseFloat(process.env.REPLY_DELAY_HOURS || '2') || 2) * 3600000;

// ---- clarification as a LIST message (Sujitha, 2026-11-25) ----
// Instead of asking the member to TYPE 1-5, send an interactive LIST:
// one "தேர்வு செய்யவும்" button that opens a list of options; the member
// taps one and the matching reply goes out. WhatsApp allows at most 10
// rows in one list; we have 7. The row id comes back as the member's
// answer (see handleMessage). Rows 6 and 7 are SEPARATE confirmation
// options — "is what you sent a prayer request?" / "is what you sent
// an offering?" — but they map to the same prayer / offering reply as
// rows 1 and 2. Sujitha's own wording, 2026-11-25.
const CLARIFY_BODY = 'நீங்கள் எதைப் பற்றி கேட்கிறீர்கள்? (கன்ஃபார்ம் செய்யுங்கள்)\nஒன்றை touch செய்யவும்.';
const CLARIFY_BUTTON = 'தேர்வு (select one)'; // max 20 chars for a list button — 'தேர்வு செய்யவும் (select one)' is 29, so the Tamil is shortened to 'தேர்வு' to fit '(select one)' (Sujitha, 2026-11-25)
const CLARIFY_ROWS = [
  { id: 'prayer', title: 'ஜெப குறிப்பு', description: 'ஜெப குறிப்பு அனுப்ப' },
  { id: 'offering', title: 'காணிக்கை', description: 'காணிக்கை (offering) பற்றிய விவரம் அறிய.' },
  { id: 'joining', title: 'குரூப்பில் சேர', description: 'புதிதாக குரூப்பில் சேர' },
  { id: 'zoom', title: 'ஜெபக்கூடுகை', description: 'ஜெபக்கூடுகையில் கலந்து கொள்ள' },
  { id: 'slot', title: 'ஸ்லாட் புக்', description: 'ஊழியங்களை செய்ய ஸ்லாட் புக் பண்ண' },
  { id: 'prayer-confirm', title: 'ஜெபக்குறிப்பா?', description: 'நீங்கள் அனுப்பி உள்ளது ஜெபக்குறிப்பா?' },
  { id: 'offering-confirm', title: 'காணிக்கையா?', description: 'நீங்கள் அனுப்பி உள்ளது காணிக்கையா?' },
];
// Row id -> reply kind. The two '-confirm' rows map to prayer / offering
// (same reply as rows 1 and 2).
const CLARIFY_ID_TO_KIND = {
  prayer: 'prayer',
  offering: 'offering',
  joining: 'joining',
  zoom: 'zoom',
  slot: 'slot',
  'prayer-confirm': 'prayer',
  'offering-confirm': 'offering',
};

const TEMPLATES = {
  prayer: path.join(TEMPLATES_DIR, 'prayer-request.jpg'),
  offering: path.join(TEMPLATES_DIR, 'offering-thanks.jpg'),
  // Joining welcome template — NOT sent yet by Sujitha. When she sends it,
  // save it as joining-welcome.jpg in TEMPLATES_DIR; no code change needed.
  // Until then, joining messages are logged (event 'joining_no_template')
  // and NOT auto-replied, so Sujitha can reply manually. The welcome
  // wording is never invented here.
  joining: path.join(TEMPLATES_DIR, 'joining-welcome.jpg'),
  // Slot booking template (Sujitha, 2026-11-25): dark-blue starry, same style
  // as the joining image. Text: "ஒவ்வொரு நாளும் வீட்டில் இருந்தபடியே
  // கர்த்தரோடு கூட சிறிது நேரம் செலவிட விரும்புகிறீர்களா? வாங்க! நாளைய
  // தினத்திற்காக ஸ்லாட்டுகளை Book செய்யுங்கள்! ஊழியங்களை செய்து
  // ஆசீர்வாதத்தை சுலபமாக பெற்றுக்கொள்ளுங்க!"
  slot: path.join(TEMPLATES_DIR, 'slot-booking.jpg'),
  // Zoom meeting template (Sujitha, 2026-11-25): dark-orange starry, same
  // style as the other templates. Sent as an image FIRST, then the Zoom
  // link + passcode as TEXT below it (the passcode must stay visible).
  zoom: path.join(TEMPLATES_DIR, 'zoom-meeting.jpg'),
  // Clarification template (Sujitha, 2026-11-25): purple starry, same style
  // as the other templates. "Praise the Lord sister!" on top, the question
  // in the center, "touch the button below" at the bottom. Sent as the
  // image HEADER of the clarification LIST message, with the
  // "தேர்வு (select one)" button below it.
  clarify: path.join(TEMPLATES_DIR, 'clarify-template.jpg'),
};

// Ekkala Thoni WhatsApp group joining link — sent with the joining reply
// as a real BUTTON ("Ekkala Thoni Link") the member taps to join.
// Change it with the JOINING_LINK env var; the default is the group's
// invite link from the slot website ("Join Ekkala Thoni Group").
const JOINING_LINK = process.env.JOINING_LINK || 'https://chat.whatsapp.com/F0mUV4iwdgjIRQO2MzymTO';
const JOINING_TEXT = `எக்காள தொனி குரூப்பில் சேர, இந்த link-ஐ தொடவும்:\n${JOINING_LINK}`;
// Body text for the joining BUTTON message (image header + button). Wrapped
// in *...* so WhatsApp renders it BOLD. Names the button explicitly, so
// members know exactly what to tap (Sujitha, 2026-11-21).
const JOINING_BODY = '*எக்காள தொனி குரூப்பில் சேர, கீழே உள்ள \'EKKALA THONI LINK\' என்கிற button-ஐ தொடவும்.*';
const JOINING_BUTTON_LABEL = 'EKKALA THONI LINK'; // max 20 chars (17) — ALL CAPS so it looks bigger and bolder

// ---- text reply (no image) for the prayer-meeting option ----
// Option 4 (prayer meeting): the Zoom link as tappable TEXT, not an image,
// so the member can tap it straight into the meeting. It stays TEXT (not a
// button) because the passcode must be visible as text.
const ZOOM_TEXT = 'ஜெபக்கூடுகையில் கலந்துகொள்ள Zoom link:\nhttps://zoom.us/j/7101504678\nPasscode: 123';
// Zoom now sends its template image + this text (sendZoomReply below), so
// TEXT_REPLY_KINDS is empty for now; kept for any future text-only kind.
const TEXT_REPLY_KINDS = {};

// ---- slot reply as a BUTTON (Sujitha, 2026-11-25) ----
// Option 5 (slot booking): NOT plain text — a real tappable BUTTON, like the
// joining "EKKALA THONI LINK" button. The body names the button; tapping it
// opens the slot website. No link printed in the text.
const SLOT_LINK = 'https://ekkala-thoni-slots.tiiny.site';
const SLOT_BUTTON_LABEL = 'SLOT BOOK'; // max 20 chars (9) — ALL CAPS so it looks bigger and bolder (WhatsApp does not let us set the button font size; caps is the way to make it look bigger, same as 'EKKALA THONI LINK')
const SLOT_BODY = 'ஊழியங்களை செய்ய ஸ்லாட் புக் பண்ண கீழே உள்ள button-ஐ touch செய்யவும்.';

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---- logging ----
function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

// ---- delayed reply queue (survives restarts) ----
// Replies wait REPLY_DELAY_MS after the member's message before going out.
// The queue is a JSON file, so a pending reply survives a server restart:
// on startup, due replies are picked up and sent by the timer below.
function loadReplies() {
  try { const a = JSON.parse(fs.readFileSync(REPLIES_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveReplies(list) {
  fs.writeFileSync(REPLIES_FILE, JSON.stringify(list, null, 2));
}
// Queue a template reply for `to`, due after the delay. If the same person
// already has the same kind pending, move it to the latest message's time
// (so repeated messages don't pile up into several replies).
function queueReply(to, kind, via) {
  const list = loadReplies();
  const sendAt = Date.now() + REPLY_DELAY_MS;
  const existing = list.find((r) => r.to === to && r.kind === kind);
  if (existing) { existing.sendAt = sendAt; existing.via = via; }
  else list.push({ to, kind, via, sendAt });
  saveReplies(list);
  log({ event: 'reply_queued', to, kind, via, sendAt: new Date(sendAt).toISOString(), delayHours: REPLY_DELAY_MS / 3600000 });
}
// Queue the clarification LIST the same way. The list content is fixed
// (CLARIFY_ROWS), so no text is stored — only the kind and reason.
function queueClarify(to, reason) {
  const list = loadReplies();
  const sendAt = Date.now() + REPLY_DELAY_MS;
  const existing = list.find((r) => r.to === to && r.kind === 'clarify');
  if (existing) { existing.sendAt = sendAt; }
  else list.push({ to, kind: 'clarify', reason, sendAt });
  saveReplies(list);
  log({ event: 'clarify_queued', to, sendAt: new Date(sendAt).toISOString(), delayHours: REPLY_DELAY_MS / 3600000 });
}
// Send every reply whose time has come. Runs on a timer (see bottom).
async function processDueReplies() {
  const list = loadReplies();
  const now = Date.now();
  const due = list.filter((r) => r.sendAt <= now);
  if (!due.length) return;
  const remaining = list.filter((r) => r.sendAt > now);
  saveReplies(remaining);
  for (const r of due) {
    try {
      if (r.kind === 'clarify') {
        // Clarification goes out as an interactive LIST, not plain text.
        if (DRY_RUN) log({ event: 'dry_run_send_list', to: r.to, image: TEMPLATES.clarify, body: CLARIFY_BODY, rows: CLARIFY_ROWS.map((x) => x.id), reason: r.reason });
        else {
          const id = await sendClarifyList(r.to);
          log({ event: 'clarify_sent', to: r.to, messageId: id, reason: r.reason, list: true });
        }
      } else if (r.kind === 'slot') {
        // Slot: a BUTTON reply (cta_url), not plain text (Sujitha, 2026-11-25).
        if (DRY_RUN) log({ event: 'dry_run_send_slot_button', to: r.to, body: SLOT_BODY, button: SLOT_BUTTON_LABEL, url: SLOT_LINK });
        else {
          const id = await sendSlotButton(r.to);
          log({ event: 'slot_button_sent', to: r.to, messageId: id, via: r.via });
        }
      } else if (r.kind === 'zoom') {
        // Zoom: template image FIRST, then the Zoom link + passcode as TEXT
        // below it (the passcode must stay visible as text, Sujitha 2026-11-25).
        if (DRY_RUN) log({ event: 'dry_run_send_zoom', to: r.to, image: TEMPLATES.zoom, text: ZOOM_TEXT });
        else {
          const id = await sendZoomReply(r.to);
          log({ event: 'zoom_reply_sent', to: r.to, messageId: id, via: r.via });
        }
      } else if (TEXT_REPLY_KINDS[r.kind]) {
        // plain TEXT reply (link), not a template image.
        if (DRY_RUN) log({ event: 'dry_run_send_text', to: r.to, kind: r.kind, text: TEXT_REPLY_KINDS[r.kind] });
        else {
          const id = await sendText(r.to, TEXT_REPLY_KINDS[r.kind]);
          log({ event: 'text_reply_sent', to: r.to, kind: r.kind, messageId: id, via: r.via });
        }
      } else {
        await replyWithTemplate(r.to, r.kind, r.via);
      }
    } catch (e) {
      log({ event: 'queued_reply_error', to: r.to, kind: r.kind, error: String(e).slice(0, 300) });
    }
  }
}

// ---- excluded senders (never auto-replied) ----
// Some people only FORWARD other members' offering screenshots in bulk
// (e.g. the sister who collects Google Pay receipts and sends 5-6 at a
// time) — they are not offering themselves, so they must get NO reply.
// List their WhatsApp numbers (wa_id, country code, no + or spaces) in
// excluded.json (an array, e.g. ["919876543210"]) and/or in the
// EXCLUDED_NUMBERS env var (comma-separated). Sujitha, 2026-11-21.
const EXCLUDED_FILE = path.join(__dirname, 'excluded.json');
function loadExcluded() {
  const set = new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const n of arr) set.add(String(n).replace(/\D/g, ''));
  } catch { /* no file yet — fine */ }
  for (const n of (process.env.EXCLUDED_NUMBERS || '').split(',')) {
    const d = n.replace(/\D/g, '');
    if (d) set.add(d);
  }
  return set;
}

// ---- fully excluded senders (NO reply to ANY message) ----
// A second, stricter list (Sujitha, 2026-11-22): some senders get NO
// auto-reply at all, whatever they send — text, voice, photo, anything.
// Their numbers go in excluded-full.json (same wa_id format) and/or in
// the EXCLUDED_FULL_NUMBERS env var (comma-separated). Unlike the
// screenshot-only list above, this is checked at the top of
// handleMessage, before any classification or transcription happens.
const EXCLUDED_FULL_FILE = path.join(__dirname, 'excluded-full.json');
function loadExcludedFull() {
  const set = new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(EXCLUDED_FULL_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const n of arr) set.add(String(n).replace(/\D/g, ''));
  } catch { /* no file yet — fine */ }
  for (const n of (process.env.EXCLUDED_FULL_NUMBERS || '').split(',')) {
    const d = n.replace(/\D/g, '');
    if (d) set.add(d);
  }
  return set;
}
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

async function sendImage(to, imagePath, caption) {
  const mediaId = await uploadImage(imagePath);
  const image = { id: mediaId };
  if (caption) image.caption = caption;
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
        image,
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

// Payment check for the OCR text read out of a photo (tesseract).
// A screenshot counts as a Google Pay receipt ONLY if the OCR text
// shows the Google Pay app name (Sujitha, 2026-11-26: only a "gpay
// screenshot" triggers the offering template).
//
// BUG FIX (Sujitha, 2026-11-26): the old list had bare 'sent', 'rs',
// 'paid', 'success', 'receipt', 'amount'. ANY WhatsApp screenshot has
// those words — e.g. the system line "New messages will disappear ...
// after they're sent" — so a random screenshot (status views, a chat,
// anything) was misread as a Google Pay receipt and got the offering
// thanks template, even when the person asked something completely
// different (a song question). PhonePe / Paytm / other screenshots and
// random photos get NO reply now.
const PAYMENT_APP_WORDS = [
  'google pay', 'gpay',
];
function looksLikePaymentReceipt(ocrText) {
  const t = (ocrText || '').toLowerCase();
  return PAYMENT_APP_WORDS.some((w) => t.includes(w));
}
// Read the text out of an image (tesseract OCR) and say whether it looks
// like a payment receipt. Returns '' on any failure (treated as not a receipt).
function ocrImage(filePath) {
  return new Promise((resolve) => {
    execFile('tesseract', [filePath, 'stdout', '--psm', '6'],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { log({ event: 'ocr_error', error: String(err).slice(0, 200) }); return resolve(''); }
        resolve((stdout || '').trim());
      });
  });
}

// Joining reply as ONE interactive message: the welcome image on top and a
// real "Ekkala Thoni Link" BUTTON below it. Tapping the button opens the
// group invite link, so the member joins the group. This is a free-form
// interactive (cta_url) message — it needs NO template approval, it works
// inside the 24-hour window after the member messaged first.
async function sendJoiningButton(to) {
  const mediaId = await uploadImage(TEMPLATES.joining);
  const body = await graphJson(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          header: { type: 'image', image: { id: mediaId } },
          body: { text: JOINING_BODY },
          action: {
            name: 'cta_url',
            parameters: { display_text: JOINING_BUTTON_LABEL, url: JOINING_LINK },
          },
        },
      }),
    }
  );
  return body.messages && body.messages[0] ? body.messages[0].id : JSON.stringify(body);
}

// Send the clarification as an interactive LIST message with the pink
// clarification template image on top. The member taps the
// "தேர்வு (select one)" button, sees the 7 options, and taps one —
// no typing needed. This is a free-form interactive message, so it works
// inside the 24-hour window after the member messaged first.
async function sendClarifyList(to) {
  const mediaId = await uploadImage(TEMPLATES.clarify);
  const body = await graphJson(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'image', image: { id: mediaId } },
          body: { text: CLARIFY_BODY },
          action: {
            button: CLARIFY_BUTTON,
            sections: [{ title: 'தேர்வு', rows: CLARIFY_ROWS }],
          },
        },
      }),
    }
  );
  return body.messages && body.messages[0] ? body.messages[0].id : JSON.stringify(body);
}

// Slot reply as ONE interactive message: the slot image on top, body text,
// and a real BUTTON below it. Tapping the button opens the slot website,
// so the member books a slot.
// This is a free-form interactive (cta_url) message — it needs NO template
// approval, it works inside the 24-hour window after the member messaged first.
async function sendSlotButton(to) {
  const mediaId = await uploadImage(TEMPLATES.slot);
  const body = await graphJson(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          header: { type: 'image', image: { id: mediaId } },
          body: { text: SLOT_BODY },
          action: {
            name: 'cta_url',
            parameters: { display_text: SLOT_BUTTON_LABEL, url: SLOT_LINK },
          },
        },
      }),
    }
  );
  return body.messages && body.messages[0] ? body.messages[0].id : JSON.stringify(body);
}

// Zoom reply: template image FIRST, then the Zoom link + passcode as TEXT.
// The passcode must stay visible as text, so it is NOT inside the image.
// If the image is missing, fall back to the text alone.
async function sendZoomReply(to) {
  if (!fs.existsSync(TEMPLATES.zoom)) {
    log({ event: 'template_missing', kind: 'zoom', imagePath: TEMPLATES.zoom });
    return await sendText(to, ZOOM_TEXT);
  }
  const imageId = await sendImage(to, TEMPLATES.zoom);
  const textId = await sendText(to, ZOOM_TEXT);
  return textId || imageId;
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
  if (kind === 'joining') {
    // Try the button message first. If it fails for any reason, fall back
    // to the image + link caption, so the member still gets the reply.
    try {
      const messageId = await sendJoiningButton(to);
      log({ event: 'reply_sent', to, kind, imagePath, messageId, via, button: true });
      return { sent: true, kind, messageId };
    } catch (err) {
      log({ event: 'joining_button_failed', to, error: String(err).slice(0, 300) });
    }
  }
  // Prayer / offering, or joining fallback: image (+ link caption for joining).
  const caption = kind === 'joining' ? JOINING_TEXT : undefined;
  const messageId = await sendImage(to, imagePath, caption);
  log({ event: 'reply_sent', to, kind, imagePath, messageId, via, caption: !!caption });
  return { sent: true, kind, messageId };
}

async function handleMessage(msg) {
  const from = msg.from; // sender wa_id
  const messageId = msg.id;
  const type = msg.type;

  // FULL exclusion (Sujitha, 2026-11-22): numbers on this list get NO
  // reply to ANY message — text, voice, photo, anything. Checked first,
  // before any classification, transcription or OCR.
  if (loadExcludedFull().has(String(from).replace(/\D/g, ''))) {
    log({ event: 'excluded_full_sender', from, messageId, type, note: 'fully excluded — no reply to any message' });
    return;
  }

  // The screenshot-only excluded senders are handled in the image branch
  // below — NOT here. A sister on that list still gets normal replies for
  // prayer requests, joining and her own offering texts; only the bulk
  // forwarded Google Pay receipt screenshots get no reply.

  // Interactive list reply: the member tapped an option in the
  // clarification LIST. The row id comes back (list_reply.id) — map it
  // to the reply kind and queue it. No typing or classification needed.
  if (type === 'interactive') {
    const inter = msg.interactive || {};
    const reply = inter.list_reply || inter.button_reply || {};
    const rowId = reply.id || '';
    const kind = CLARIFY_ID_TO_KIND[rowId];
    if (!kind) {
      log({ event: 'interactive_unknown', from, messageId, rowId, title: reply.title || '' });
      return;
    }
    const pending = loadPending();
    if (pending[from]) { delete pending[from]; savePending(pending); }
    if (kind === 'joining' && !fs.existsSync(TEMPLATES.joining)) {
      log({ event: 'joining_no_template', from, messageId, note: 'member tapped joining in the list but no joining template file yet' });
      return;
    }
    log({ event: 'incoming', from, messageId, source: 'clarification list tap', text: rowId });
    queueReply(from, kind, 'clarification-list tap: ' + rowId);
    return;
  }

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
  } else if (type === 'image') {
    // Photo message. A Google Pay receipt screenshot = offering proof
    // (Sujitha, 2026-11-21) and gets the offering template. A random photo
    // (a friend's photo, a snapshot, anything shared) gets NO reply.
    // How we tell them apart: if the image has a caption, classify it;
    // otherwise read the image with OCR and look for the Google Pay app
    // name only (Sujitha, 2026-11-26 — "gpay screenshot" only). No
    // Google Pay name = random photo, no reply.
    //
    // EXCEPTION — bulk forwarders (Sujitha, 2026-11-21): the sister who
    // collects OTHER members' Google Pay receipts and forwards 5-6 at a
    // time is on the excluded list. Her SCREENSHOTS get NO reply at all.
    // But if the same sister sends a prayer request, a joining request or
    // her own offering text/voice, she DOES get the normal template.
    if (loadExcluded().has(String(from).replace(/\D/g, ''))) {
      log({ event: 'excluded_sender', from, messageId, type, note: 'bulk screenshot forwarder — screenshots get no reply' });
      return;
    }
    const caption = (msg.image && msg.image.caption) || '';
    if (caption.trim()) {
      text = caption;
      source = 'image caption';
    } else if (DRY_RUN) {
      // No credentials: can't download the image to OCR it. Log it and
      // treat it as offering (the common case) so dry-run tests still flow.
      log({ event: 'incoming', from, messageId, source: 'image (no caption, dry-run) -> offering', text: '' });
      queueReply(from, 'offering', 'google-pay receipt screenshot (dry-run)');
      return;
    } else {
      try {
        const file = await downloadMedia(msg.image.id);
        const ocrText = await ocrImage(file);
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        if (looksLikePaymentReceipt(ocrText)) {
          log({ event: 'incoming', from, messageId, source: 'image OCR -> payment receipt -> offering', text: ocrText.slice(0, 200) });
          queueReply(from, 'offering', 'google-pay receipt screenshot');
        } else {
          log({ event: 'image_ignored', from, messageId, reason: 'no payment words in OCR text — random photo, no reply', ocrText: ocrText.slice(0, 200) });
        }
      } catch (e) {
        log({ event: 'image_error', from, messageId, error: String(e).slice(0, 300) });
      }
      return;
    }
  } else {
    log({ event: 'ignored_type', from, messageId, type });
    return;
  }

  log({ event: 'incoming', from, messageId, source, text: text.slice(0, 500) });

  const pending = loadPending();
  const result = classify(text);

  // Answer to the clarification question takes priority.
  // 1 prayer, 2 offering, 3 joining, 4 prayer meeting (Zoom link),
  // 5 slot booking (slot website link).
  if ((result.kind === 'choice-1' || result.kind === 'choice-2' || result.kind === 'choice-3' || result.kind === 'choice-4' || result.kind === 'choice-5') && pending[from]) {
    const kind = result.kind === 'choice-1' ? 'prayer'
      : result.kind === 'choice-2' ? 'offering'
      : result.kind === 'choice-3' ? 'joining'
      : result.kind === 'choice-4' ? 'zoom' : 'slot';
    delete pending[from];
    savePending(pending);
    if (kind === 'joining' && !fs.existsSync(TEMPLATES.joining)) {
      log({ event: 'joining_no_template', from, messageId, note: 'member answered 3 but no joining template file yet' });
      return;
    }
    queueReply(from, kind, 'clarification-answer');
    return;
  }

  if (result.kind === 'prayer' || result.kind === 'offering' || result.kind === 'joining' || result.kind === 'zoom' || result.kind === 'slot') {
    if (pending[from]) { delete pending[from]; savePending(pending); }
    if (result.kind === 'joining' && !fs.existsSync(TEMPLATES.joining)) {
      // Template not sent yet — log prominently, do NOT send a wrong image
      // and do NOT invent welcome wording. Sujitha replies manually.
      log({ event: 'joining_no_template', from, messageId, text: text.slice(0, 200), reason: result.reason });
      return;
    }
    queueReply(from, result.kind, result.reason);
    return;
  }

  // Unclear (including empty transcription): ask which one it is.
  pending[from] = { askedAt: new Date().toISOString(), text: text.slice(0, 200) };
  savePending(pending);
  queueClarify(from, result.reason);
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
      replyDelayHours: REPLY_DELAY_MS / 3600000,
      pendingReplies: loadReplies().length,
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
  console.log(`Reply delay: ${REPLY_DELAY_MS / 3600000} hours after the member messages (change with REPLY_DELAY_HOURS)`);
  console.log(`Templates: prayer=${TEMPLATES.prayer} (${fs.existsSync(TEMPLATES.prayer) ? 'found' : 'MISSING'})`);
  console.log(`           offering=${TEMPLATES.offering} (${fs.existsSync(TEMPLATES.offering) ? 'found' : 'MISSING'})`);
  console.log(`           joining=${TEMPLATES.joining} (${fs.existsSync(TEMPLATES.joining) ? 'found' : 'NOT SENT YET — joining messages will be logged, not auto-replied'})`);
  console.log(`Verify token: ${VERIFY_TOKEN === 'ekkala-thoni-verify' ? 'DEFAULT — set WHATSAPP_VERIFY_TOKEN in .env' : 'set'}`);
  console.log(`Log file: ${LOG_FILE}`);
});

// Every 30 seconds, send any queued reply whose 2-hour wait is over.
// Also runs once at startup, so replies queued before a restart still go out.
setInterval(() => { processDueReplies().catch((e) => log({ event: 'queue_timer_error', error: String(e).slice(0, 200) })); }, 30000);
processDueReplies().catch((e) => log({ event: 'queue_startup_error', error: String(e).slice(0, 200) }));

// Exported for local tests (test-ocr.js) — the server still starts
// normally when run directly.
module.exports = { looksLikePaymentReceipt };
