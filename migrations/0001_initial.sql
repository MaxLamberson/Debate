-- Forum HQ: one D1 database for team data and optional private document/video chunks.
-- All data is private; no public R2 bucket or paid services are required.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
  password_hash TEXT, role TEXT NOT NULL DEFAULT 'novice',
  active INTEGER NOT NULL DEFAULT 1, partner_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL, expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS availability (
  user_id INTEGER NOT NULL, day INTEGER NOT NULL, hour INTEGER NOT NULL,
  PRIMARY KEY(user_id, day, hour), FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, event_date TEXT NOT NULL, event_time TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'normal',
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  task_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, PRIMARY KEY(task_id,user_id),
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, task_id INTEGER,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT '',
  stored_name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new',
  feedback TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  upload_state TEXT NOT NULL DEFAULT 'ready',
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
);
-- Store actual bytes in private SQL BLOBs (max 1.5MB per part; D1 max 2MB/row).
CREATE TABLE IF NOT EXISTS submission_chunks (
  submission_id INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY(submission_id,part),
  FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id INTEGER NOT NULL, slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started', notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, PRIMARY KEY(user_id,slug),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  category TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL, category TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 3, positive TEXT NOT NULL DEFAULT '',
  focus TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(author_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  side TEXT NOT NULL, category TEXT NOT NULL,
  argument TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  source_url TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL, FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_user ON assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_submission_user ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_progress_user ON lesson_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_mistakes_user ON mistakes(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
-- Idempotent seed: don't recreate team or overwrite existing work on redeploy.
INSERT INTO users(name,username,role,created_at)
SELECT 'Alaina','alaina','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='alaina');
INSERT INTO users(name,username,role,created_at)
SELECT 'Aanya','aanya','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='aanya');
INSERT INTO users(name,username,role,created_at)
SELECT 'Kai','kai','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='kai');
INSERT INTO users(name,username,role,created_at)
SELECT 'Parker','parker','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='parker');
INSERT INTO users(name,username,role,created_at)
SELECT 'Lukas','lukas','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='lukas');
INSERT INTO users(name,username,role,created_at)
SELECT 'Shikha','shikha','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='shikha');
INSERT INTO users(name,username,role,created_at)
SELECT 'Xia','xia','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='xia');
INSERT INTO users(name,username,role,created_at)
SELECT 'Akari','akari','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='akari');
INSERT INTO users(name,username,role,created_at)
SELECT 'Kaori','kaori','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='kaori');
INSERT INTO users(name,username,role,created_at)
SELECT 'Max','max','admin',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='max');
INSERT INTO users(name,username,role,created_at)
SELECT 'Lucy','lucy','novice',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM users WHERE username='lucy');
INSERT INTO tournaments(title,event_date,details,created_at)
SELECT 'Novice Tournament','2026-12-13','Team''s first novice tournament. Details and location to be confirmed.',datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM tournaments WHERE title='Novice Tournament' AND event_date='2026-12-13');
INSERT INTO announcements(title,body,pinned,created_at)
SELECT 'Welcome to Forum HQ','Set your weekly availability, check your assignments, and upload practice work here. New members: start with the Training tab. Tournament prep starts now.',1,datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title='Welcome to Forum HQ');
INSERT INTO resources(title,category,description,url,body,created_at)
SELECT 'PF round format & speech order','Guide','Constructive 4m, crossfire 3m, rebuttal 4m, summary 3m, final focus 2m; 3 minutes of prep per team.','','Use the Practice tab for full-round and drill timers.',datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM resources WHERE title='PF round format & speech order');
INSERT INTO resources(title,category,description,url,body,created_at)
SELECT 'Beginner case checklist','Template','Build claims with reasoning, evidence, impact, and clear weighing.','','Resolution → stance → framework → 2–3 contentions → warrants → credible dated evidence → impact → responses → source list.',datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM resources WHERE title='Beginner case checklist');
INSERT INTO resources(title,category,description,url,body,created_at)
SELECT 'Evidence quality rubric','Guide','Prefer qualified authors, transparent methods, recent relevant data, and accurate context.','','Check author, publisher, date, methodology, causality, sample size, and whether your card actually supports its claim.',datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM resources WHERE title='Evidence quality rubric');
