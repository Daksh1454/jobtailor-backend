// server.js
//
// Phase 2 starter backend for JobTailor AI.
//
// What this adds over the Phase 1 (BYOK) extension:
//   - Users pay via Stripe Checkout instead of bringing their own Claude key.
//   - This server holds ONE server-side Claude key and proxies requests for
//     any user with an active subscription.
//
// Subscriber records live in Postgres (see db.js) rather than a local file,
// so they survive Render redeploys/restarts. Auth is still a simple
// email+token scheme (not full session auth) — fine at this scale, worth
// revisiting if you ever need multi-device login or password resets.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { nanoid } = require("nanoid");
const Stripe = require("stripe");
const rateLimit = require("express-rate-limit");
const db = require("./db");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Free trial length in days before the first charge. Defaults to 5 if
// STRIPE_TRIAL_DAYS isn't set; set it to 0 to disable the trial entirely.
const TRIAL_DAYS = process.env.STRIPE_TRIAL_DAYS !== undefined ? parseInt(process.env.STRIPE_TRIAL_DAYS, 10) || 0 : 5;

// ---------- Rate limiting ----------
// Protects the single shared Claude API key from runaway loops or abuse.
// Keyed by the caller's account (x-user-email) once authenticated, so it
// caps each real subscriber rather than just their IP (which can change).
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // generous for real use (a handful of tailored resumes/cover letters), blocks scripts/loops
  keyGenerator: (req) => req.header("x-user-email") || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit reached (30 generations/hour). Please wait a bit and try again." }
});

// Looser IP-based limiter on checkout creation, just to stop scripted spam
// from opening a flood of Stripe sessions.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many checkout attempts. Please wait a few minutes and try again." }
});

// Idempotent: creates a user + access token on first activation, reuses the
// existing token on renewals so already-activated extensions keep working.
// Shared by the webhook (source of truth for ongoing status) and the
// checkout-success endpoint (so the success page can show a code immediately
// instead of racing the webhook).
async function activateUser(email, stripeCustomerId) {
  const existing = await db.getUserByEmail(email);
  const token = existing?.token || nanoid(24);
  const user = await db.upsertUser({
    email,
    token,
    stripeCustomerId: stripeCustomerId || existing?.stripe_customer_id,
    subscriptionActive: true
  });
  return user.token;
}

// ---------- Stripe webhook needs the raw body, so register it BEFORE express.json() ----------
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      if (email) {
        await activateUser(email, session.customer);
        console.log(`Activated subscription for ${email}`);
      }
    }

    if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.paused") {
      const sub = event.data.object;
      const user = await db.setSubscriptionActiveByStripeCustomerId(sub.customer, false);
      if (user) console.log(`Deactivated subscription for ${user.email}`);
    }
  } catch (err) {
    // Stripe retries webhooks on non-2xx, so surface DB errors instead of
    // silently swallowing them — a transient DB hiccup shouldn't permanently
    // miss an activation/deactivation event.
    console.error("Webhook handler error:", err);
    return res.status(500).json({ error: "Internal error processing webhook" });
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

// Serve success.html/cancel.html explicitly (rather than a blanket static
// folder) so we're not accidentally exposing server.js/package.json etc.
// over HTTP if they end up sitting in the same directory on GitHub.
app.get("/success.html", (req, res) => res.sendFile(path.join(__dirname, "success.html")));
app.get("/cancel.html", (req, res) => res.sendFile(path.join(__dirname, "cancel.html")));

// ---------- Create a Stripe Checkout session ----------
app.post("/api/checkout", checkoutLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  try {
    // {CHECKOUT_SESSION_ID} is a Stripe template string it fills in automatically.
    const successUrl = `${process.env.SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: successUrl,
      cancel_url: process.env.CANCEL_URL,
      // Free trial before the first charge, to lower the barrier to try the
      // product. Card is still collected at checkout (Stripe requires this
      // for subscription-mode Checkout Sessions), so this isn't a card-less
      // trial — it just delays the first charge, and cancelling before the
      // trial ends means never being charged. Length is configurable via env
      // var so it can be tuned without a code change; unset/0 disables it.
      ...(TRIAL_DAYS > 0 ? { subscription_data: { trial_period_days: TRIAL_DAYS } } : {}),
      // Stripe's newer "Managed Payments" (auto merchant-of-record tax handling)
      // is on by default for new accounts and requires a tax code on the
      // product before it'll process anything. Controlled by an env var
      // (default off) so switching this on for live mode is a config change,
      // not a code edit — see README's "Taxes (Managed Payments)" section.
      managed_payments: { enabled: process.env.STRIPE_MANAGED_PAYMENTS === "true" }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Called by success.html right after checkout ----------
// Verifies payment directly with Stripe (not just trusting the redirect) and
// activates the account immediately, rather than waiting on the webhook.
app.get("/api/checkout-success", async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "session_id is required" });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    // A checkout with a free trial completes with payment_status
    // "no_payment_required" (nothing is actually charged yet) rather than
    // "paid" — both mean checkout succeeded and the subscription is real,
    // just at different billing states. Only "unpaid" is a real failure.
    const validStatuses = ["paid", "no_payment_required"];
    if (!validStatuses.includes(session.payment_status)) {
      return res.status(402).json({ error: "Payment not completed yet." });
    }
    const email = session.customer_email || session.customer_details?.email;
    const token = await activateUser(email, session.customer);
    res.json({ email, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Check subscription status (extension polls this after checkout) ----------
app.get("/api/status", async (req, res) => {
  try {
    const { email, token } = req.query;
    const user = await db.getUserByEmail(email);
    const active = !!(user && user.token === token && user.subscription_active);
    res.json({ active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't check subscription status right now." });
  }
});

// ---------- Auth middleware for the paid endpoints ----------
async function requireActiveSubscription(req, res, next) {
  try {
    const email = req.header("x-user-email");
    const token = req.header("x-user-token");
    const user = await db.getUserByEmail(email);

    if (!user || user.token !== token || !user.subscription_active) {
      return res.status(402).json({ error: "No active subscription. Subscribe to use JobTailor AI." });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't verify subscription right now." });
  }
}

// ---------- Same prompts as the Phase 1 extension's background.js ----------
const RESUME_SYSTEM_PROMPT = `You are an expert resume writer and career coach.
Given a candidate's base resume and a specific job posting, rewrite the resume
so it is tightly tailored to that job: reorder and reweight bullet points to
foreground the most relevant experience, mirror key terminology from the job
description (without keyword-stuffing), and keep every fact truthful to the
original resume — never invent experience, skills, or metrics the candidate
did not provide. Keep bullets similarly concise to the original (don't pad
length) so the result still fits comfortably on one page.

The candidate's base resume is plain text extracted from a two-column PDF
template: each work/project/education entry has an organization+location line
followed by a role+dates line, then bullet points. Parse it back into that
structure using standard resume conventions (locations look like "City, ST"
or "Remote"; dates look like month/year ranges).

Respond with ONLY valid JSON — no markdown code fences, no commentary before
or after — matching exactly this schema:

{
  "name": string,
  "contact": string,
  "sections": [
    {
      "title": string,
      "entries": [
        {
          "left": string or null,
          "right": string or null,
          "subLeft": string or null,
          "subRight": string or null,
          "bullets": string[]
        }
      ]
    }
  ]
}

Rules: keep every section from the source resume, in the same order, with the
same section titles. For sections that are just grouped lines with no
organization/role structure (e.g. a skills section), set left/right/subLeft/
subRight to null and put each line in "bullets". Use null (not empty string)
when a field doesn't apply. Do not add sections that weren't in the source.`;

const COVER_LETTER_SYSTEM_PROMPT = `You are an expert cover letter writer.
Given a candidate's resume and a specific job posting, write a concise,
specific, non-generic cover letter (under 350 words) that connects the
candidate's real experience to the role's actual requirements. Avoid cliches
("I am writing to express my interest..."), avoid inventing facts not present
in the resume, and reference at least one concrete detail from the job
description. Output only the cover letter text, no preamble or explanation.`;

app.post("/api/generate", requireActiveSubscription, generateLimiter, async (req, res) => {
  const { resume, job, mode } = req.body;
  if (!resume || !job?.description) {
    return res.status(400).json({ error: "resume and job.description are required" });
  }

  const systemPrompt = mode === "cover-letter" ? COVER_LETTER_SYSTEM_PROMPT : RESUME_SYSTEM_PROMPT;
  const userPrompt = `JOB TITLE: ${job.title || "Not specified"}\nCOMPANY: ${job.company || "Not specified"}\n\nJOB DESCRIPTION:\n${job.description}\n\nBASE RESUME:\n${resume}`;
  const maxTokens = mode === "cover-letter" ? 1500 : 4000;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    // Claude sometimes emits an extended-thinking block before the actual
    // text block, so find the text block by type rather than assuming
    // content[0] is always the answer.
    const textBlock = data.content?.find((block) => block.type === "text");
    const text = textBlock?.text?.trim() || "";

    if (!text) {
      // Log the full response so we can see stop_reason / content shape in
      // Render's Logs tab instead of silently sending back an empty string.
      console.error("Empty completion from Claude:", JSON.stringify(data));
      throw new Error(`Claude returned an empty response (stop_reason: ${data.stop_reason || "unknown"}). Try again, or shorten your resume/job description if this repeats.`);
    }

    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;

db.initDb()
  .then(() => {
    app.listen(port, () => console.log(`JobTailor backend listening on port ${port}`));
  })
  .catch((err) => {
    console.error("Failed to initialize the database. Check DATABASE_URL.", err);
    process.exit(1);
  });
