# Forum HQ — Cloudflare Workers + D1 edition

**The same Forum HQ design and team workflows, adapted for the Cloudflare Workers Free plan.**

The frontend (`public/index.html`, `public/static/style.css`, and all of the original navigation, lessons, drills and timers in `public/static/app.js`) is retained from the FastAPI version. Only server calls for large file transfers were adapted to send small chunks automatically; the form still looks and works the same way.

## What is included

- **Private username/password portal**. No public registration. Admin (`max`) and individual member accounts.
- **Original 11-member roster**: Alaina, Aanya, Kai, Parker, Lukas, Shikha, Xia, Akari, Kaori, Max, Lucy. Others begin as novices; adjust officer/partner roles in the app.
- **Availability**: weekdays 4–8 PM and weekends 10 AM–8 PM, in Pacific Time, plus the team overlap view.
- **Assignments**: individual assignees, status, priority, due dates, task submissions.
- **Private submissions**: PDF, documents, images, audio, and video up to 50 MB per file, or a Google Drive/video URL. Private download and admin feedback. Bigger files are sent in small chunks automatically.
- **Resources, announcements, tournament calendar** (December 13, 2026 novice tournament seeded).
- **Training, cases/evidence library, random topic and argument generators, debate drill/round timers, speaker feedback, and mistake log**.
- **Uncertain work remains uncertain**: new cases default to draft, self-reported lesson confidence is not mastery, and unresolved mistake items remain in review sets.

### Cost and storage limitations

This edition uses **Cloudflare Workers + Cloudflare D1 only**. It **does not use R2**, a paid web service, a paid Workers plan, a credit card, or Cloudflare Access. To stay at $0, **keep your account on the Workers Free plan**; do not upgrade.

- As of November 2026, Workers Free includes 100,000 requests/day and a 10 ms CPU-time limit per request. D1 Free has enforced row-read/write limits and a **500 MB maximum per database**.
- Uploaded files are stored as private BLOB chunks in D1. **The application deliberately stops new file uploads when its recorded file sizes would exceed 350 MiB**, leaving room for tasks, posts, and DB overhead. A private Drive link continues to work if storage fills.
- Individual file limit is **50 MiB** to match the original, but large video uploads and downloads may take longer and should be tested on your live Free account; there is no guarantee Cloudflare's CPU and network limits will support every large transfer. This is an inherent trade-off of using no R2 and no paid storage.
- D1 Free will block requests if you exceed its hard limits, instead of incurring usage charges. Cloudflare does not promise the app will always be available if limits are exceeded.
- You must **make backups**. D1 is the only place your team data resides once deployed. The older Codespaces SQLite database does not automatically migrate.

Documentation: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 Free enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

## Hosting steps (Cloudflare and GitHub Codespaces)

**Prerequisites:** GoDaddy domain with Cloudflare nameservers configured; its zone is `Active` in Cloudflare; D1 database named **`forum-hq-db`** already created; private GitHub repo and Codespace.

### 1. Replace the old project files

Unzip this new `forum-hq-cloudflare.zip`. Upload **the contents of the extracted folder** into your existing private GitHub repository's **top level** (the same level as this README). In Codespaces File Explorer, that level should now contain `wrangler.jsonc`, `package.json`, `src/`, `migrations/`, `public/`, `scripts/`, `tests/`.

The earlier Python version (`app.py`, `manage.py`, `requirements.txt`, `render.yaml`, and the old top-level `static/`) is **not required** in this Cloudflare project. You can delete those from the new repository or leave them, but only this Worker project is deployed. **Do not** upload `data/`, `.env`, database files, credentials, or a `node_modules/` folder into GitHub. Make sure `wrangler.jsonc` and `package.json` are *not* inside an extra nested `forum-hq-cloudflare` directory.

### 2. Install dependencies and connect Cloudflare

Open a Codespaces terminal **in the directory containing `package.json`**. Run:

```bash
npm install
npx wrangler login
npx wrangler d1 list
```

A Cloudflare authorization window may open. Sign in to the **same Cloudflare account** in which you created `forum-hq-db`.

Find the `database_id` for `forum-hq-db` in `d1 list` (UUID like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Open **`wrangler.jsonc`** and replace this placeholder:

```json
"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

with your **actual** D1 ID. Keep the binding name `DB` and database name `forum-hq-db` unchanged.

### 3. Create the remote database tables

```bash
npm run db:remote
```

Confirm when Wrangler asks if you want to apply `0001_initial.sql` to the **remote** database. This creates all the tables, sample resources, team members and December 13 tournament. It is idempotent on repeat and won't replace the team's work.

### 4. Set your Max administrator password

```bash
npm run admin:remote
```

When prompted, type a unique password (minimum 10 characters), then repeat it. The terminal shows asterisks instead of your password. The script hashes it and updates the seeded `max` account in D1; it **does not put your plaintext password in GitHub**. Keep this secret. If you run the script again, you reset Max's password and invalidate old sessions.

### 5. Deploy the site

```bash
npm run deploy
```

Wrangler prints a site URL resembling `https://forum-hq.YOUR-CLOUDFLARE-SUBDOMAIN.workers.dev`. **This is a real, online site now**; try signing in as `max` with the password from Step 4.

If it says a database binding is missing or the database ID is invalid, re-check `wrangler.jsonc` and that you logged into the correct account. If it says `no such table`, rerun `npm run db:remote`.

### 6. Attach your GoDaddy domain (managed by Cloudflare)

1. Cloudflare Dashboard → **Workers & Pages** → **forum-hq** Worker.
2. Open **Settings → Domains & Routes** (sometimes shown as **Domains & Routes** on the Worker overview).
3. Click **Add** → **Custom Domain**.
4. Enter the exact domain that is **Active** in Cloudflare, such as `debate.example.com` or `yourdomain.com`.
5. Confirm. Cloudflare will set up the DNS and TLS certificate automatically for the custom domain. You normally **do not create a manual DNS record** for this Worker custom domain.
6. Visit `https://YOUR-DOMAIN` and sign in.

Cloudflare documentation: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

### 7. Configure the team in the website

- Open **Team members**, set the officers and permanent partners.
- Generate/reset individual temporary passwords and share them privately, one member at a time.
- Test an announcement, an assignment, a member availability selection, a case marked `needs_review`, and a file submission.
- Check a novice account can't see another member's private submission or speaker feedback.
- Only members with the `admin` role can create assignments, announcements and review submissions. The default `max` account is an admin.

### 8. Commit changes to GitHub

In the Codespaces terminal:

```bash
git add .
git commit -m "Deploy Forum HQ to Cloudflare Workers and D1"
git push
```

Your GitHub repo stores the source code; Cloudflare hosts the app. When you change the code later, run `npm run deploy` again. **Redeploying does not erase D1 data.**

## Optional: test locally first

```bash
npm install
npm run db:local
npm run admin:local
npm run dev
```

Open the local Wrangler URL (usually `http://127.0.0.1:8787`). In GitHub Codespaces, use the **Ports** panel to open the forwarded port. Local D1 is separate from your live database.

### Automated tests

`npm test` requires Node.js 22 or newer, and runs built-in unit/integration tests against an in-memory SQLite stand-in for D1. They cover login, CSRF, team privacy, assignments, availability, cases, mistake log, feedback, and actual binary multipart/chunked file workflows. These tests are **not equivalent to a live Cloudflare production test**, particularly for large video files or the Workers CPU-time limit.

## Backups (important)

Regularly export the production D1 database from your Codespace:

```bash
npx wrangler d1 export forum-hq-db --remote --output forum-hq-backup.sql
```

**Never commit the backup into GitHub or share it publicly.** It contains private student information, password hashes, and uploaded file bytes. Store it securely off-platform and follow your school's policies. Some large exports may need special handling; monitor actual DB size and verify restoration on a *separate* test DB before relying on backups. D1 also has limited Time Travel on Free.

## Troubleshooting

| What you see | What to do |
|---|---|
| `database_id ... invalid` | Replace placeholder in `wrangler.jsonc` with ID shown by `npx wrangler d1 list`. |
| `no such table: users` | Run `npm run db:remote` for deployed Worker, or `npm run db:local` in local preview. |
| Max can't sign in | Run `npm run admin:remote`, then deploy if needed. No preset password ships in ZIP. |
| `Worker exceeded resource limits` | Free 10ms CPU limit. Try a smaller attachment; use a private Drive link for big recordings. Keep Workers Free. |
| `storage ... limit exceeded` | D1 Free is limited to 500MB/database; use private Drive links for videos and archive data. |
| Domain not available | Ensure Cloudflare zone is Active and your custom domain was added on the Worker. |
| I changed source code but live site didn't update | Run `npm run deploy` after pushing or editing. |

## Privacy and security notes

Passwords are salted PBKDF2-HMAC-SHA256 hashes (310,000 iterations); never stored in plaintext. Sessions are stored as hashed random tokens and use secure, HttpOnly, SameSite cookies. All changes require a per-session CSRF token. Member-only API endpoints check identity and authorization on the server. Uploads are D1 BLOBs served only after private permission checks. A login form doesn't hide the website's static HTML/JavaScript, but no team data is exposed to visitors without a valid account. Login attempts are rate-limited via D1.

No automated antivirus scanning, email, or third-party media hosting are included. For student privacy, limit account access to your approved team members and avoid uploading sensitive personal documents. Regularly remove outdated submissions or use privately shared Drive links for large media. There is no public registration.

**Important version note:** The previous FastAPI application's `scrypt` hashes and local SQLite `data/` are **not automatically compatible with this new system**. New member passwords are generated by Max, and this edition initializes a fresh D1 database. If you already entered significant data in the old Codespaces instance, do not delete that old database until you have exported/migrated it.
