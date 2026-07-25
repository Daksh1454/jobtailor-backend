# JobTailor AI — Backend (Phase 2: Subscriptions)

$12/month subscriptions via Stripe, so JobTailor AI users don't need their own Claude API key. This README assumes you're starting from zero on Stripe.

**Only do this once real people are using the Phase 1 extension and telling you they'd pay.** If you haven't validated that yet, go run the Phase 1 version first.

---

## Part 1 — Set up Stripe (from scratch)

1. Go to https://dashboard.stripe.com/register and create an account. Verify your email. You do **not** need to finish full business/bank verification to test in Stripe's sandbox ("test mode") — that's only required before you can accept real money.
2. You'll land in **Test mode** by default (toggle top-right of the dashboard). Stay in test mode until everything works end-to-end.
3. Go to **Product catalog** → **Add product**.
   - Name: `JobTailor AI Subscription`
   - Pricing model: `Recurring`
   - Price: `$12.00 / month`
   - Save.
4. Click into the product and copy the **Price ID** (starts with `price_...`). This goes in `STRIPE_PRICE_ID`.
5. Go to **Developers** → **API keys**. Copy the **Secret key** (starts with `sk_test_...`). This goes in `STRIPE_SECRET_KEY`.
6. Leave **Developers → Webhooks** for now — you need a public URL first, which means deploying (Part 3) before you can finish this step. Come back to it.

## Part 2 — Get a server-side Claude key

Same as before (https://console.anthropic.com), but this time it's **your** key, used for every subscriber's requests — not a per-user key. Put it in `ANTHROPIC_API_KEY`.

Cost awareness: a single resume-tailoring generation is roughly 1-2k output tokens, which costs a small fraction of a cent to a few cents depending on the model. At $12/month per subscriber, a user would need to generate hundreds of resumes in a month before that cost became a problem — but keep an eye on usage in the Anthropic console once you have real subscribers, especially if someone scripts abuse of the endpoint.

## Part 3 — Deploy to Render

1. Push this `jobtailor-backend` folder to a new GitHub repo (Render deploys from Git).
2. Go to https://render.com, sign up, click **New** → **Web Service**, connect the repo.
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: Free (fine for early testing; upgrade once you have real traffic)
4. Under **Environment**, add all the variables from `.env.example` *except* leave `STRIPE_WEBHOOK_SECRET`, `SUCCESS_URL`, and `CANCEL_URL` for now — you don't have real values yet.
5. Deploy. Render gives you a public URL like `https://jobtailor-backend-xxxx.onrender.com`.
6. Now go back into Render's environment variables and set:
   - `SUCCESS_URL` = `https://jobtailor-backend-xxxx.onrender.com/success.html`
   - `CANCEL_URL` = `https://jobtailor-backend-xxxx.onrender.com/cancel.html`
7. Back in Stripe: **Developers** → **Webhooks** → **Add endpoint**.
   - Endpoint URL: `https://jobtailor-backend-xxxx.onrender.com/api/webhook`
   - Events to send: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.paused`
   - Save, then copy the **Signing secret** (starts with `whsec_...`).
8. Paste that into Render's `STRIPE_WEBHOOK_SECRET` env var and save — Render will redeploy automatically.

Note: Render's free tier spins down after inactivity, so the first request after idle time can take ~30-50 seconds. Fine for testing; consider a paid plan once you have paying users so checkouts don't feel slow.

## Part 4 — Wire the extension to this backend

1. Open `jobtailor-extension/config.js` and set:
   ```js
   const BACKEND_URL = "https://jobtailor-backend-xxxx.onrender.com";
   ```
2. Reload the extension (`chrome://extensions` → the reload icon on JobTailor AI).
3. In the extension's Settings tab, under **Subscription**, enter an email and click **Subscribe**. It opens Stripe Checkout in a new tab.
4. Use Stripe's test card to pay: `4242 4242 4242 4242`, any future expiry date, any 3-digit CVC, any ZIP.
5. After payment, the success page shows an access code. Copy it, paste it into the extension's **Access code** field, click **Activate**.
6. The extension should now say "Using: JobTailor subscription" and generate without needing a personal API key.

## Going live (real payments)

1. In Stripe, flip out of test mode, create the same product/price in **live mode**, and grab live keys (`sk_live_...`, a new live webhook + `whsec_...`, a live `price_...`).
2. Update Render's env vars with the live values.
3. Double check `ANTHROPIC_API_KEY` has enough billing headroom for real usage.
4. From here, standard Stripe rules apply: you're responsible for handling refunds, disputes, and tax/compliance obligations for your jurisdiction — Stripe's dashboard and docs (https://docs.stripe.com/tax) cover the basics, but for anything beyond simple cases it's worth double-checking with an accountant, since this isn't something to guess your way through.

## Known limitations (fine for validation, not for scale)

- `db.json` is a flat file, not a real database — replace with Postgres/SQLite before you have more than a handful of concurrent users, or a Render redeploy could theoretically race with a write.
- The access-code copy/paste flow is manual. Once you have paying users, a proper email/login flow is worth building — but not before.
- No rate limiting on `/api/generate` yet — add some (e.g. a simple per-user daily cap) before opening this up publicly, so one user can't run your Anthropic bill up.
