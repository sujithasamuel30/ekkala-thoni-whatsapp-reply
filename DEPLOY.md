# DEPLOY.md — Put the WhatsApp auto-reply server on Render (free)

**Status: everything is prepared, but the server is NOT live on the
internet yet.** Deploying needs a Render account and a GitHub account.
Both are free and neither needs a credit card. No account has been
created — that step needs Sujitha (or someone with her) to sign up,
because the accounts must be hers.

## Why Render (free)

Checked 2026-11-21 against current pricing pages:

| Host | Cost | Card? | Stays awake? | Fits this server? |
|---|---|---|---|---|
| **Render Free (chosen)** | **$0 forever** | **No** | Sleeps after 15 min idle; wakes in ~30–60 s (see below) | Yes — 512 MB RAM, Docker, Node + Python |
| Koyeb Free | $0 | **Yes — card + $29 hold** | Scales to zero after 1 h idle; wakes in 1–5 s | Yes, but needs a card |
| Railway | $5/mo Hobby after 30-day trial | Yes for Hobby | No sleep | Trial is only 30 days; Free plan's $1/mo credit cannot run a 24/7 server |
| Fly.io | ~$3.70/mo (512 MB) | Yes | No sleep | No free tier for new accounts since Oct 2024 |
| Oracle Always Free VM | $0 forever | Yes (verification) | Always on, 6 GB RAM | Best technically, but needs a card + manual server setup (SSH, HTTPS cert) |

**The sleep question (honest):** Render's free service spins down after
15 minutes with no traffic. If a member messages while it is asleep,
Meta's first delivery attempt times out, Meta retries, and the retry
wakes the service — so the reply still arrives, just ~1–2 minutes late
on the first message after a quiet spell. Two ways to avoid even that:
1. **UptimeRobot (free, no card):** a monitor that pings
   `https://<your-url>/health` every 5 minutes keeps the service awake
   around the clock. Render's free tier gives 750 instance-hours/month;
   24/7 is 720 hours, so it fits. This is the recommended setup — see
   step 7.
2. **Pay $7/month (Render Starter):** no sleep, 1 GB RAM. Only needed
   if the keep-awake ping is not wanted, or if voice transcription ever
   runs out of memory (see "If something goes wrong" below).

**RAM note:** 512 MB is tight for voice transcription (Node ~60–100 MB
+ Python/faster-whisper `tiny` peaks around 300–450 MB). It should fit,
but if a voice message ever crashes the service with an out-of-memory
error, the fix is Render Starter ($7/mo, 1 GB RAM). Text messages never
come near the limit.

## What you need before starting

- A **GitHub account** (free, no card). Sign up at https://github.com/signup
  if there is none. (Render deploys from a GitHub repo.)
- A **Render account** (free, no card). Sign up at https://render.com
  — "Sign up with GitHub" is the easiest.
- The Meta values (Phone Number ID, permanent access token, verify
  token) — these come from the Meta Business setup (SETUP.md Part A).
  **They can be added later:** the service starts and answers `/health`
  without them; it just stays in DRY_RUN (classify + log, no sending)
  until they are set.

## Step 1 — Push this folder to GitHub

On this computer, in the project folder:

```bash
cd ~/workspace/whatsapp-auto-reply
git init
git add server.js classify.js transcribe.py requirements.txt \
  Dockerfile render.yaml .dockerignore .gitignore \
  templates/ test-classifier.js config.env.example README.md SETUP.md DEPLOY.md
git commit -m "Ekkala Thoni WhatsApp auto-reply"
git branch -M main
# Create an empty repo on GitHub first (e.g. name: ekkala-thoni-whatsapp-reply),
# then:
git remote add origin https://github.com/<your-github-username>/ekkala-thoni-whatsapp-reply.git
git push -u origin main
```

Do NOT add `.env`, `venv/`, or `logs/` — `.gitignore` already excludes
them. Never commit the access token.

## Step 2 — Create the service on Render

1. Log in at https://dashboard.render.com → **New +** → **Web Service**.
2. Choose **Build and deploy from a Git repository** → connect the
   GitHub repo from step 1.
3. Render detects `render.yaml` (Blueprint) and fills in: Name
   `ekkala-thoni-whatsapp-reply`, Runtime **Docker**, Plan **Free**,
   Region **Oregon**, Health check path `/health`.
4. It will ask for the three `sync: false` environment variables
   (Phone Number ID, access token, verify token). Leave them empty for
   now if the Meta setup is not done yet — they can be added later in
   the dashboard (Environment tab) and the service redeploys itself.
   For the verify token, choose any secret string (e.g.
   `ekkala-thoni-verify`) and remember it — the same string goes into
   Meta's webhook settings.
5. Click **Deploy**. First build takes ~5–10 minutes (it installs the
   Python voice-transcription packages). Watch the build log for errors.

## Step 3 — Check it is up

Open in a browser:

```
https://ekkala-thoni-whatsapp-reply.onrender.com/health
```

You should see something like:

```json
{"ok":true,"dryRun":true,"templates":{"prayer":true,"offering":true,"joining":true},"verifyTokenSet":false,"credentialsPresent":false}
```

- `templates` all `true` = the three images are in place.
- `dryRun: true` + `credentialsPresent: false` = Meta values not set
  yet. That is expected until step 4.
- After the Meta values are set in the dashboard, `/health` should show
  `"dryRun":false` and `"credentialsPresent":true`.

**Your public webhook URL is:**

```
https://ekkala-thoni-whatsapp-reply.onrender.com/webhook
```

## Step 4 — Finish the Meta setup (SETUP.md Part A)

1. In Meta (developers.facebook.com → the app → WhatsApp →
   Configuration), set the webhook:
   - **Callback URL:** `https://ekkala-thoni-whatsapp-reply.onrender.com/webhook`
   - **Verify token:** the same secret string you set in step 2.
   - Click **Verify and save**, then subscribe the webhook to the
     **`messages`** field.
2. In the Render dashboard → Environment, set:
   - `WHATSAPP_PHONE_NUMBER_ID` — from Meta API Setup page
   - `WHATSAPP_ACCESS_TOKEN` — the **permanent** token (system user,
     `whatsapp_business_messaging`). Not the 24-hour token.
   - `WHATSAPP_VERIFY_TOKEN` — same string as in the webhook settings.
   Render redeploys automatically when env vars change.
3. Re-check `/health` — `dryRun` should now be `false`.

## Step 5 — Live test

From another phone, send a text to the US number:

- "Please pray for my mother" → prayer image comes back.
- "I sent Rs 500 offering" → offering image comes back.
- "I want to join the group" → joining image comes back.
- Send a voice note with a prayer request → same prayer image back.

Check what happened in Render dashboard → Logs (the server logs every
message, classification and reply). Note: on Render free there is no
persistent disk, so `logs/replies.log` does not survive restarts —
**Render's log stream is where replies are visible**, and
`pending.json` (members waiting for the 1/2/3 answer) resets if the
service restarts; members can just message again.

## Step 6 (recommended) — Keep it awake with UptimeRobot (free)

1. Free account at https://uptimerobot.com (no card).
2. Add Monitor → Monitor Type **HTTP(s)**, Friendly Name e.g.
   `Ekkala Thoni WhatsApp reply`, URL
   `https://ekkala-thoni-whatsapp-reply.onrender.com/health`,
   Monitoring Interval **5 minutes**.
3. It pings `/health` every 5 minutes, so Render never sees 15 idle
   minutes and the service stays awake. It also emails you if the
   service ever goes down.

## Monthly template updates

Templates change once a month. When Sujitha sends new ones:

1. Replace the files in `~/workspace/your_files/whatsapp-auto-reply-templates/`
   (canonical copies) **and** in `templates/` in this project folder.
2. `git add templates/ && git commit -m "New monthly templates" && git push`
3. Render redeploys automatically — new images are live in a few minutes.
   No code change is ever needed for a template change.

## If something goes wrong

- **Build fails on Render:** open the build log in the Render dashboard.
  The most likely step to fail is the `pip install` (network hiccup) —
  click **Manual Deploy → Deploy latest commit** to retry.
- **Service runs out of memory on a voice message:** Render logs will
  show the process being killed. Fix: upgrade the service to **Starter
  ($7/month, 1 GB RAM, no sleep)** in the dashboard — no code change.
- **Replies are ~1–2 minutes late sometimes:** the service fell asleep
  (step 6 not set up, or UptimeRobot paused). Set up the UptimeRobot
  monitor; Meta's retry means no message is lost.
- **Webhook verification fails in Meta:** the verify token in Meta must
  match `WHATSAPP_VERIFY_TOKEN` in Render exactly, and the service must
  be up (check `/health` first).

## What survives a restart of this computer (VM)

**Everything.** Once deployed, the server runs on Render's computers,
not on this VM. Restarting or replacing this VM does not stop it. This
VM is only needed to edit the code or templates and `git push` a change.
The local server currently running on this VM (`http://localhost:3000`)
is then redundant — stop it once the Render service is live and verified,
so there is only one copy of the system running.
