# Lead Follow-up Engine — Rings & I

Tracks every virtual-appointment lead from **Appointment Booked** to **Order Placed**.
Import the Zoho Bookings export; Ring Experts log in with their own PIN and update stages; managers see the dashboard.

## Who sees what

| Role | Sees | Can do |
|---|---|---|
| **Admin** | All leads | Everything + Import + Users (add people, reset PINs, deactivate) + remove leads |
| **Manager** | All leads | Update stages, notes, follow-ups, reassign leads, dashboard |
| **Ring Expert** | Only leads where the CRM "Ring Expert" name matches their profile | Update stages, notes, follow-ups on their own leads |

Permissions are enforced on the server, not just hidden in the screen.

## Deploy on Vercel (one time, ~15 minutes)

1. **Put the code on GitHub.** Create a new **private** repository (e.g. `lead-followup-engine`), click *uploading an existing file*, and drag in everything from this folder (`api`, `lib`, `public`, `package.json`, `dev.js`, `README.md`, `.gitignore`). Commit.
2. **Import into Vercel.** vercel.com → *Add New… → Project* → pick the repo → Framework preset **Other** → leave build settings empty → **Deploy**. (The first deploy will show a "Database not connected" message at login — that's expected.)
3. **Add the database.** In the Vercel project → **Storage** tab → *Create Database* → **Upstash for Redis** (free plan) → connect it to this project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
4. **Add two settings.** Project → **Settings → Environment Variables**:
   - `SESSION_SECRET` — any long random text, 32+ characters (e.g. from a password manager). Keeps logins secure. Changing it logs everyone out.
   - `ADMIN_PIN` — your admin PIN/password (use 8+ characters; this account can see everything).
   - Optional: `ADMIN_USERNAME` (default `admin`), `ADMIN_DISPLAY_NAME` (default `Admin`, shown in activity logs — e.g. `Soham`).
5. **Redeploy.** Deployments tab → ⋯ on the latest → *Redeploy*. Settings only apply after a redeploy.
6. Open the site → log in as `admin` with your `ADMIN_PIN`.

## First use

1. **Import** tab → upload the Zoho Bookings export (CSV or .xlsx) → check the column matching → *Import*.
2. **Users** tab → add each person: display name, username, role, and for Ring Experts the **Ring Expert name exactly as it appears in the CRM** (pick from the list). Give them a starting PIN.
3. Share the site link + their username + PIN privately. They can change their PIN from the top bar.

## Daily routine

- Upload the full Zoho export once a day (same file every time is fine). Customers are matched by phone, then email. Stages set by Ring Experts are never overwritten; a lead only moves on new CRM info (booked → completed, or a lost lead re-booking).
- Ring Experts work from **Follow-ups** (overdue / today / next 7 days) and update the stage after every call.
- Screens refresh every minute while open (click "Up to date" in the top bar to refresh now).

## Security notes

- PINs are stored hashed (scrypt), never in plain text. 5 wrong attempts lock that username for 15 minutes.
- Deactivating someone or resetting their PIN logs them out everywhere immediately.
- The site is marked `noindex`, but anyone with the link sees the login page — use 6+ character PINs for everyone.
- Customer phone numbers and emails sit in your Upstash database. Keep the Vercel and Upstash accounts on the company email with 2-factor login.

## Running it on your laptop (optional)

```
npm install
SESSION_SECRET=some-long-random-text ADMIN_PIN=1234 npm run dev
```
Open http://localhost:3000. Without Upstash settings it uses a temporary in-memory database.

## Files

- `public/` — the app (index.html, app.js, core.js — core.js holds the stage rules and import logic, shared with the server)
- `api/` — server endpoints: login, me, leads, sync, action, import, users, pin
- `lib/` — auth (sessions, PIN hashing, roles) and database connection
