# Vercel + Neon deployment

This is an owner-operated, single-account testnet prototype. Never share the
dashboard token with judges: it grants trading access. Use a separate paper
deployment for shared interactive access and record the owner testnet workflow.

1. Create a Neon project on its Free plan. In Connect disable connection pooling
   and copy the **direct** PostgreSQL URL. Keep it private. The session lock used
   by this app requires a direct connection, not a `-pooler` hostname.
2. Import this repository into Vercel Hobby. The checked-in `vercel.json` supplies
   the static build and API routing. Use Node 24. No HOST or PORT is needed.
3. Set server-only environment variables for Production:
   - DATABASE_URL: Neon direct connection string including sslmode=require.
   - DASHBOARD_TOKEN: generate at least 32 random characters locally, e.g.
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - EXECUTION_MODE: paper for initial smoke testing, then testnet.
   - STRIKE_PUBLIC_KEY and STRIKE_PRIVATE_KEY: the matched API wallet pair from
     your local saved connection. Never put these in a public-prefixed variable,
     source code, screenshots or chat.
   - STRIKE_SUB_ACCOUNT_ID: only if using a dedicated subaccount.
4. Deploy. The first authenticated planner request creates the Postgres table.
   Open Connect & launch and enter DASHBOARD_TOKEN. Hosted wallet generation and
   connection changes are disabled; edit environment variables and redeploy.
5. Verify /health, authentication, paper preview/execute/close, and persistence
   after redeployment. Then enable testnet, verify account, preview a plan and
   explicitly approve a testnet submission. Inspect matching order IDs in Strike.
6. Refresh confirms fills and protection. Monitoring runs every 15 seconds while
   the dashboard is open, or on explicit Refresh; there is no background worker
   or scheduled monitoring. Native bracket orders remain at Strike independently.

Each planner request uses a dedicated Postgres connection and a session advisory
lock. Writes commit before exchange submission, so process termination leaves a
durable submission marker. Later requests reconcile it without retrying the trade.
Database failures block execution. A request timeout means inspect/refresh, never
blindly submit a replacement. Do not change account credentials or execution mode
while an active plan exists. Free plan quotas apply; this is not a production SLA.

The cloud database starts empty; local history and credentials are not uploaded.
Local `npm start` continues using SQLite. Live Vercel/Postgres and hosted testnet
verification still need to be completed after provisioning the database.
