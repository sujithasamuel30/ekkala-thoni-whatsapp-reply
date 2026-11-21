# SETUP.md — WhatsApp auto-reply for Ekkala Thoni Ministries

The server is built and tested. It is **not live yet** — Meta needs the
number connected and a public URL before any real message can arrive.

## What the system does (final, as decided 2026-11-20)

- Members message the ministry **1:1** (text or voice) with a prayer
  request, an offering, or a request to join.
- The server reads it, decides **prayer request vs offering vs
  joining**, and sends back the matching template **IMAGE**
  automatically:
  - Prayer → `prayer-request.jpg`
  - Offering → `offering-thanks.jpg`
  - Joining (new member) → `joining-welcome.jpg` — **template NOT
    sent yet.** Until Sujitha sends it, joining messages are only
    logged (`joining_no_template` in `logs/replies.log`) and NOT
    auto-replied, so she can reply manually. No welcome wording is
    ever invented.
- If it cannot tell, it asks: "Prayer request-a, Offering-a, illa
  Joining-a? 1 / 2 / 3" (the "3" option appears only once the
  joining template file exists; until then the question is 1 / 2).
- Voice messages are transcribed first (local Whisper), then classified
  the same way.
- **Replies are FREE** (service messages — the member messaged first;
  1,000/month free). **No daily reminders** in this system.
- **The group is never touched.** Auto-reply is 1:1 only.
- **Number: Sujitha's US number** (known to everyone — the reply must
  come from her number so members recognise it). Connected via Meta
  WhatsApp Cloud API with **Coexistence**, so the number stays in the
  WhatsApp app and the group keeps working.
- **Templates change once a month.** When Sujitha sends new ones,
  replace `offering-thanks.jpg` / `prayer-request.jpg` in
  `~/workspace/your_files/whatsapp-auto-reply-templates/` — no code
  change needed. The server reads the files fresh on every reply.
- **Joining template (still awaited).** When Sujitha sends the welcome
  template, save it as `joining-welcome.jpg` in the same templates
  folder — no code change needed; the server picks it up automatically,
  the clarification question starts offering "3", and joining messages
  start getting auto-replied. Until then, check `logs/replies.log` for
  `joining_no_template` events and reply to those new members manually.

## Part A — What Sujitha must do on the Meta side (in order)

Do these in a browser on a computer. Keep the phone with the US number
nearby — an OTP (6-digit code) will come to it.

1. **Facebook / Meta account.** Log in to Facebook with the account
   that owns the ministry's Meta Business account (create one at
   business.facebook.com if there is none).
2. **Create a Meta developer app** at developers.facebook.com → My Apps
   → Create App → choose "Other" → type "Business". Give it a name,
   e.g. `Ekkala Thoni Auto Reply`.
3. **Add WhatsApp.** In the app dashboard → Add Product → WhatsApp →
   Set up. This creates a WhatsApp Business Account.
4. **Add the US phone number.** In WhatsApp → API Setup → add the US
   number. Choose **Coexistence** (use the number in the WhatsApp app
   AND the API) — this is what keeps the number working in the app
   and the group untouched. Meta sends an OTP to the number; enter it.
5. **Copy the Phone Number ID.** On the API Setup page, under "Send
   and receive messages", copy the **Phone number ID** (a long number).
6. **Create a permanent access token.** Meta → Business Settings →
   Users → System Users → Add a system user (name it e.g.
   `ekkala-thoni-bot`) → give it WhatsApp access → Generate a new
   token with `whatsapp_business_messaging` permission. Copy the
   token and keep it secret. (A short-lived token from the API Setup
   page expires in 24 hours — do NOT use that one.)
7. **Set the webhook.** The server needs a **public https URL** first
   (Part B). In the app dashboard → WhatsApp → Configuration → edit
   the webhook: Callback URL = `https://<your-public-url>/webhook`,
   Verify token = any secret string you choose (e.g.
   `ekkala-thoni-verify`). Click Verify and save. Then subscribe the
   webhook to the **`messages`** field.
8. **Paste the values into the server config** (Part C) and restart
   the server.
9. **Test.** Send a text message to the US number from another phone:
   "Please pray for my mother" → the prayer image should come back.
   Then "I sent Rs 500 offering" → the offering image should come
   back. Then "I want to join the group" → the joining image should
   come back (only after `joining-welcome.jpg` has been added).
   Check `logs/replies.log` to see what the server did.

## Part B — The server needs a PUBLIC https URL

Meta can only call a webhook it can reach on the internet. The server
running on this computer (`http://localhost:3000`) is **not** reachable
by Meta on its own.

**Prepared path (2026-11-21): Render free tier — see DEPLOY.md.**
`Dockerfile`, `render.yaml`, `.dockerignore`, `.gitignore` and the
`templates/` deploy copies are ready in this folder. Render is $0,
no credit card, permanent free tier (512 MB RAM, sleeps after 15 min
idle — DEPLOY.md explains the webhook effect and the free UptimeRobot
keep-awake fix). Still needs: a GitHub account + a Render account
(both free, no card) and a `git push`. No account has been created yet.

Other options (not prepared):

- **Easiest for testing: ngrok.** Install ngrok, run
  `ngrok http 3000`, and use the `https://....ngrok.io` URL it shows
  as the webhook Callback URL. Free ngrok URLs change on every restart
  — re-enter the new URL in Meta each time.
- **For permanent use: a small cloud host** (e.g. a $5/month VPS, or
  Render / Railway / Fly.io free tier). Put this project folder on the
  host, set the same environment variables, and use its https URL.
  The server has no database — just Node, the venv, and the two
  template images.

Do NOT claim the local server alone is live until a public URL is set
and Meta's webhook verification succeeds.

## Part C — Server config (values from Part A)

```bash
cd ~/workspace/whatsapp-auto-reply
cp config.env.example .env
# Edit .env and fill in:
#   WHATSAPP_PHONE_NUMBER_ID=   (step 5)
#   WHATSAPP_ACCESS_TOKEN=      (step 6, permanent token)
#   WHATSAPP_VERIFY_TOKEN=      (step 7, must match Meta exactly)
#   PORT=3000
```

Start the server:

```bash
cd ~/workspace/whatsapp-auto-reply
node server.js
```

Check it is up: `curl http://localhost:3000/health` — it should show
`"dryRun":false`, both templates `true`, and `"credentialsPresent":true`.

## Test without Meta (already done, works)

```bash
cd ~/workspace/whatsapp-auto-reply
node test-classifier.js   # 19 samples: prayer / offering / 1 / 2 / unclear
```

To test the webhook locally (dry-run, no credentials needed):

```bash
node server.js   # in one terminal; DRY_RUN is on when credentials are missing
curl -s "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=ekkala-thoni-verify&hub.challenge=TEST123"
# -> prints TEST123
curl -s -X POST http://localhost:3000/webhook -H 'Content-Type: application/json' \
  -d '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"from":"919999999991","id":"wamid.1","type":"text","text":{"body":"Please pray for my mother"}}]},"field":"messages"}]}]}'
# -> EVENT_RECEIVED; check logs/replies.log for the dry-run reply
```

## How voice transcription works

- Voice/audio messages are downloaded from Meta, then transcribed
  **locally** with faster-whisper (free, no API key) using the `tiny`
  model in `venv/`. No audio leaves this machine.
- `tiny` is fast but its Tamil accuracy is limited. If Tamil voice
  messages are misread, set `WHISPER_MODEL=base` in `.env` (better
  Tamil, slower, ~145 MB download on first use) and restart.
- If transcription fails or returns empty text, the server asks the
  clarification question instead of guessing.
- Fixed during build: faster-whisper 1.2.1 needs PyAV `av==18.0.0`
  (av 19 removed the `metadata_errors` argument it calls). The venv
  is pinned in `requirements.txt` — reinstall with
  `./venv/bin/pip install -r requirements.txt` if the venv is rebuilt.

## Checking what happened

- `logs/replies.log` — one JSON line per event: incoming message,
  classification + reason, template sent (or clarification asked),
  and any error. Read it to check any reply.
- `pending.json` — members waiting for the 1 / 2 clarification
  answer. Safe to delete to reset.

## What is still blocked (needs Sujitha / Meta)

1. Meta Business app + WhatsApp product + US number connected with
   Coexistence + OTP (Part A, steps 1–4).
2. Phone Number ID + permanent access token (steps 5–6).
3. A public https URL for the webhook (Part B) + webhook subscribed
   to `messages` (step 7).
4. A live test with a real text and a real voice message.
