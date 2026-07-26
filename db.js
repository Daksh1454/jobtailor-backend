// db.js
//
// Postgres-backed persistence, replacing the old file-based db.json.
// Designed for a free-tier Postgres provider like Neon or Supabase — just
// set DATABASE_URL and everything else here is provider-agnostic.
//
// Render's free web-service tier wipes local disk on every redeploy/restart,
// which was silently deleting all subscriber records. A real database
// (this file) fixes that: the data lives outside the web service entirely.

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn(
    "WARNING: DATABASE_URL is not set. The server will crash on first DB " +
      "query. See jobtailor-backend/README.md 'Database (Postgres)' section."
  );
}

// Most free Postgres providers (Neon, Supabase, Render Postgres) require SSL
// and use a certificate that Node won't validate against by default; this is
// the standard, documented way to connect to them from a simple script.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("sslmode=disable") ? false : { rejectUnauthorized: false }
});

// Creates the table on first boot if it doesn't exist yet. Safe to call on
// every startup — CREATE TABLE IF NOT EXISTS is a no-op once it's there.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      stripe_customer_id TEXT,
      subscription_active BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getUserByEmail(email) {
  if (!email) return null;
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}

async function getUserByStripeCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const { rows } = await pool.query("SELECT * FROM users WHERE stripe_customer_id = $1", [stripeCustomerId]);
  return rows[0] || null;
}

// Idempotent upsert: creates the row on first activation, reuses the
// existing token on renewals so already-activated extensions keep working.
async function upsertUser({ email, token, stripeCustomerId, subscriptionActive }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, token, stripe_customer_id, subscription_active, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email) DO UPDATE SET
       token = COALESCE(users.token, EXCLUDED.token),
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, users.stripe_customer_id),
       subscription_active = EXCLUDED.subscription_active,
       updated_at = now()
     RETURNING *`,
    [email, token, stripeCustomerId || null, subscriptionActive]
  );
  return rows[0];
}

async function setSubscriptionActiveByStripeCustomerId(stripeCustomerId, active) {
  const { rows } = await pool.query(
    `UPDATE users SET subscription_active = $2, updated_at = now()
     WHERE stripe_customer_id = $1
     RETURNING *`,
    [stripeCustomerId, active]
  );
  return rows[0] || null;
}

module.exports = {
  initDb,
  getUserByEmail,
  getUserByStripeCustomerId,
  upsertUser,
  setSubscriptionActiveByStripeCustomerId
};
