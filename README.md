# WhatsApp Auto-Reply — Ekkala Thoni Ministries

Members message the ministry 1:1 (text or voice) with a prayer request,
an offering, or a request to join. This server reads it, decides prayer
vs offering vs joining, and sends back the matching template IMAGE
automatically. 1:1 only — the group is never touched. No daily reminders.

Joining is a third slot: the classifier and server already handle it,
but the welcome template (`joining-welcome.jpg`) has NOT been sent yet,
so joining messages are logged, not auto-replied, until Sujitha sends it.
No welcome wording is invented.

## Files

| File | What it is |
|---|---|
| `server.js` | Webhook server (Node, no npm dependencies). Verification, incoming messages, voice download + transcription, classification, image reply, logging. |
| `classify.js` | Prayer vs offering vs joining keyword classifier (Tamil + English). Shared by the server and the test. |
| `transcribe.py` | Voice → text with local faster-whisper (`tiny` model). Runs in `venv/`. |
| `test-classifier.js` | Classifier test, 19 samples, no Meta credentials needed. |
| `config.env.example` | Copy to `.env` and fill in Meta values. |
| `requirements.txt` | Pinned Python deps for the venv (note: `av==18.0.0`). |
| `SETUP.md` | Full setup steps for Sujitha (Meta side, public URL, config, tests). |
| `logs/replies.log` | Created at runtime — one JSON line per event. |
| `pending.json` | Created at runtime — members waiting for the 1 / 2 answer. |
| `venv/` | Python venv with faster-whisper. |

## Quick start

```bash
cd ~/workspace/whatsapp-auto-reply
node test-classifier.js   # classifier test, no credentials needed
node server.js            # starts on PORT (default 3000); DRY_RUN is on
                          # automatically when Meta credentials are missing
curl http://localhost:3000/health
```

Full setup (Meta Business app, US number with Coexistence, OTP, public
https URL, access token): see **SETUP.md**.

## Templates

Images live in `~/workspace/your_files/whatsapp-auto-reply-templates/`
(`prayer-request.jpg`, `offering-thanks.jpg`). They change once a month —
replace the files there; no code change needed.

**Joining welcome template — not sent yet.** When Sujitha sends it, save
it as `joining-welcome.jpg` in that folder. The server picks it up
automatically (no restart needed for the file itself — it is read fresh
on every reply), the clarification question starts offering "3", and
joining messages start getting auto-replied. Until then, joining
messages are logged as `joining_no_template` in `logs/replies.log`.
