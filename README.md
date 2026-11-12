# Forum HQ — private Public Forum debate team portal

An installable, full-stack website for the **2026–2027 Public Forum season**. Designed for Max and the 10 other team members, with login-required data, admin permissions, and a responsive dashboard.

## Included

| Area | What members can do | What admins can do |
|---|---|---|
| Login | Sign in, change password | Add/deactivate members, generate/reset their temporary passwords |
| Weekly availability | Select weekdays 4–8 PM, weekends 10 AM–8 PM (Pacific) | See a team-wide heatmap, common slots, individual schedules |
| Assignments | See personal tasks, update status, upload completed work | Assign to any combination of members, set due dates and priorities, see each person's status |
| Submissions | Upload files or add a Google Doc/video link, view private feedback | Open and review submissions, return revision requests |
| Resources | Browse guides, templates, links and research | Publish and remove resources |
| Announcements | Read and reference updates | Publish, pin, and delete announcements |
| Tournaments | View month calendar and event details | Add and remove competitions |
| Team | See teammates and current partners | Assign officers/novices/admin roles, pair partners, onboard additional members |
| Training | 8 PF lessons, self-reported understanding and personal notes | View each student's learning progress |
| Practice | Cold speaking, short-prep, rebuttal, crossfire, summary/final focus, topic and argument generators, timed rounds | Same tools |
| Cases/evidence | Save draft contentions, rebuttals, evidence cards and source links | Review and manage team cases |
| Speaker feedback | View own feedback | Give private, actionable feedback to individuals |
| Mistake log | Save unresolved/uncertain arguments and recurring weaknesses | See and filter review sets across the team |

**Seeded roster:** Alaina, Aanya, Kai, Parker, Lukas, Shikha, Xia, Akari, Kaori, Max, Lucy. Max is admin; all others start as `novice` until you change roles in the Team members page. The **December 13, 2026 novice tournament** is preloaded, with unconfirmed location/time clearly marked TBD.

## Run locally (Mac, Windows, or Linux)

Requires **Python 3.10+** (3.11+ recommended).

1. Unzip this project; open a terminal inside `pf-team-portal`.
2. Create and activate a virtual environment:

   ```bash
   python -m venv .venv
   source .venv/bin/activate            # macOS / Linux
   # Windows PowerShell: .venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

3. Provision the **Max** account with your own strong password:

   ```bash
   python manage.py init-admin --username max
   ```

   This prompts securely for a password. **No default administrator password ships with this project.**

4. Start the website:

   ```bash
   uvicorn app:app --reload --host 127.0.0.1 --port 8000
   ```

5. Open **http://127.0.0.1:8000** and sign in as `max` using the password you chose.

6. In **Team members**, set the correct experienced officers, choose partners, and click the shield icon for each member to create a temporary login—or use **Set initial passwords** for all unprovisioned members. Share credentials privately. Members can change passwords after sign-in.

**Important:** This localhost version is accessible only on your own computer, not to other teammates. To allow your 11 members to use it from their devices, deploy it to a HTTPS hosting service with permanent storage as described below.

## Deploy as a private website (example: Render)

This is a complete runnable project, **not an already-deployed site**. It needs a domain/hosting account and server-side data storage before anyone else can access it.

1. Put the files in a **private GitHub repository** (exclude the `data/` folder, included in `.gitignore`).
2. In [Render](https://render.com/), choose **New → Blueprint**, link your repository and select the supplied `render.yaml`.
3. Use a service plan with a **persistent disk** (the blueprint requests one). The default ephemeral filesystem on free-tier hosts would erase accounts, work and uploads on deployment/restart.
4. Supply a **unique strong** `INITIAL_ADMIN_PASSWORD` in the Render environment-variable prompt for the initial Max account. After the first successful sign-in, you may remove this variable; it is only used if Max has no password.
5. Deploy, check that the site opens at its HTTPS URL, and sign in as `max`. The blueprint enables secure session cookies and uses `/var/data` for persistent SQLite/files.
6. Turn on **regular backups** of the persistent database and uploads. If you use a custom domain, configure it through the hosting provider and enforce HTTPS.

The external website will display **only the username/password sign-in page** to unsigned visitors. There is no public registration. The server rechecks login and authorization before returning assignments, files, feedback, or admin actions; hiding a tab in the browser is **not** the access control.

### Security / operations notes

- Passwords are salted and hashed with `scrypt`, not stored as plaintext.
- Sessions use randomly generated cookie tokens, stored as hashes; cookies are HttpOnly and SameSite=Lax, with Secure enabled on HTTPS deployments.
- Mutations need a per-session CSRF token. Admin permissions and private-file access are checked on the server.
- Media uploads accept PDF, Office files, common image/video/audio formats, up to **50 MB** each. Files are stored outside public static folders and downloaded as attachments after authorization.
- There is no automatic email notification, video transcription, virus scanner, Google account sign-in, or Google Drive sync in this version. Add file scanning if accepting untrusted uploads beyond your small team.
- The calendar tracks entered tournaments; it does not pull events automatically from Tabroom or Google Calendar.
- Weekly availability repeats by weekday and hour, rather than per-date availability. All displayed time slots are **Pacific Time**.
- Host one server instance against this SQLite database. For a much larger deployment with many concurrent users, migrate to PostgreSQL/object storage.
- Back up the SQLite database consistently, ideally using SQLite's backup API, along with the entire `uploads` directory. Backups of only the main `.sqlite3` file during active writes can miss data in WAL mode.

## Code map

- `app.py` — FastAPI backend, account authentication, permissions, SQLite persistence and all API endpoints.
- `manage.py` — interactive first-admin setup.
- `static/index.html`, `static/style.css`, `static/app.js` — responsive single-page interface.
- `tests/test_portal.py` — automated checks for authentication, privacy, CSRF, scheduling, uploads, feedback and independent task progress.
- `render.yaml` — optional Render deployment example with persistent disk.

Run tests with `pytest tests -q` (install `pytest` and `httpx` if they are not available in your environment).

## How learning progress is represented

A lesson marked `confident` is explicitly **self-reported confidence**, not proof of mastery. Case files remain `draft` or `needs_review` until someone deliberately changes them. Mistake-log entries remain open or practicing until manually resolved. Repeated unresolved categories automatically rise to the top of review sets.

## PF timer reference

The full-round timer follows the standard PF sequence: constructives (4 minutes), crossfire (3), rebuttals (4), crossfire (3), summaries (3), grand crossfire (3), final focus (2), and separate 3-minute team prep time. Verify rules for each individual tournament; see the [NSDA rules website](https://www.speechanddebate.org/) and the [2026–27 OSAA/NSDA rule excerpt](https://www.osaa.org/docs/spe/AllDebateRules.pdf).
