// server.js
//
// Phase 2 starter backend for JobTailor AI.
//
// What this adds over the Phase 1 (BYOK) extension:
//   - Users pay via Stripe Checkout instead of bringing their own Claude key.
//   - This server holds ONE server-side Claude key and proxies requests for
//     any user with an active subscription.
//
// This is intentionally minimal (file-based storage, no real auth system)
// so you can understand and deploy it quickly. Before scaling past early
// users, replace db.json with a real database (Postgres/SQLite) and add
// proper session auth instead of the email+token scheme below.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { nanoid } = require("nanoid");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const DB_PATH = path.join(__dirname, "db.json");

// ---------- tiny file-based "database" ----------
function readDb() {
  if (!fs.existsSync(DB_PATH)) return { users: {} };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Idempotent: creates a user + access token on first activation, reuses the
// existing token on renewals so already-activated extensions keep working.
// Shared by the webhook (source of truth for ongoing status) and the
// checkout-success endpoint (so the success page can show a code immediately
// instead of racing the webhook).
function activateUser(email, stripeCustomerId) {
  const db = readDb();
  const existing = db.users[email];
  const token = existing?.token || nanoid(24);
  db.users[email] = {
    ...(existing || {}),
    email,
    token,
    stripeCustomerId: stripeCustomerId || existing?.stripeCustomerId,
    subscriptionActive: true
  };
  writeDb(db);
  return token;
}

// ---------- Stripe webhook needs the raw body, so register it BEFORE express.json() ----------
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = readDb();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    if (email) {
      activateUser(email, session.customer);
      console.log(`Activated subscription for ${email}`);
    }
  }

  if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.paused") {
    const sub = event.data.object;
    const user = Object.values(db.users).find((u) => u.stripeCustomerId === sub.customer);
    if (user) {
      user.subscriptionActive = false;
      writeDb(db);
      console.log(`Deactivated subscription for ${user.email}`);
    }
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
app.post("/api/checkout", async (req, res) => {
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
      // Stripe's newer "Managed Payments" (auto merchant-of-record tax handling)
      // is on by default for new accounts and requires a tax code on the
      // product before it'll process anything. Disabling it here so checkout
      // works immediately; see jobtailor-backend/README.md "Taxes" section
      // for the proper long-term fix before going live with real customers.
      managed_payments: { enabled: false }
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
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not completed yet." });
    }
    const email = session.customer_email || session.customer_details?.email;
    const token = activateUser(email, session.customer);
    res.json({ email, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Check subscription status (extension polls this after checkout) ----------
app.get("/api/status", (req, res) => {
  const { email, token } = req.query;
  const db = readDb();
  const user = db.users[email];
  const active = !!(user && user.token === token && user.subscriptionActive);
  res.json({ active });
});

// ---------- Auth middleware for the paid endpoints ----------
function requireActiveSubscription(req, res, next) {
  const email = req.header("x-user-email");
  const token = req.header("x-user-token");
  const db = readDb();
  const user = db.users[email];

  if (!user || user.token !== token || !user.subscriptionActive) {
    return res.status(402).json({ error: "No active subscription. Subscribe to use JobTailor AI." });
  }
  next();
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

app.post("/api/generate", requireActiveSubscription, async (req, res) => {
  const { resume, job, mode } = req.body;
  if (!resume || !job?.description) {
    return res.status(400).json({ error: "resume and job.description are required" });
  }

  const systemPrompt = mode === "cover-letter" ? COVER_LETTER_SYSTEM_PROMPT : RESUME_SYSTEM_PROMPT;
  const userPrompt = `JOB TITLE: ${job.title}\nCOMPANY: ${job.company}\n\nJOB DESCRIPTION:\n${job.description}\n\nBASE RESUME:\n${resume}`;
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
app.listen(port, () => console.log(`JobTailor backend listening on port ${port}`));
