"""Forum HQ — private Public Forum team portal.
Run: uvicorn app:app --host 0.0.0.0 --port 8000
"""
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DATA = Path(os.getenv("DATA_DIR", str(ROOT / "data")))
UPLOADS = DATA / "uploads"
DB_PATH = DATA / "forum.sqlite3"
DATA.mkdir(parents=True, exist_ok=True)
UPLOADS.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD = int(os.getenv("MAX_UPLOAD_MB", "50")) * 1024 * 1024
COOKIE = "forum_session"
VALID_ROLES = {"admin", "officer", "novice"}
VALID_STATUSES = {"todo", "in_progress", "submitted", "done"}
LESSON_STATUSES = {"not_started", "learning", "practicing", "confident"}
MISTAKE_STATUSES = {"open", "practicing", "resolved"}
CASE_STATUSES = {"draft", "needs_review", "ready"}
ALLOWED_SUFFIXES = {".pdf", ".doc", ".docx", ".txt", ".rtf", ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".webm", ".mp3", ".m4a", ".wav"}
LOGIN_ATTEMPTS = {}

app = FastAPI(title="Forum HQ", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=15000")
    return con


def rows(con, query, params=()):
    return [dict(r) for r in con.execute(query, params).fetchall()]


def text(v, maxlen=500, required=False):
    v = str(v or "").strip()
    if len(v) > maxlen or (required and not v):
        raise HTTPException(400, f"Enter {'a value' if required else 'shorter text'} (max {maxlen} characters).")
    return v


def clean_url(v):
    v = text(v, 2000)
    if v and urlparse(v).scheme not in {"http", "https"}:
        raise HTTPException(400, "Please use an https:// or http:// link.")
    return v


def valid_date(v):
    if not v:
        return ""
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).isoformat() if "T" in v else datetime.strptime(v, "%Y-%m-%d").date().isoformat()
    except Exception:
        raise HTTPException(400, "Invalid date.")


def hash_password(password: str):
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt$16384${salt.hex()}${key.hex()}"


def check_password(password: str, stored: Optional[str]):
    if not stored:
        return False
    try:
        scheme, cost, salt_hex, expected = stored.split("$")
        if scheme != "scrypt":
            return False
        key = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=int(cost), r=8, p=1, dklen=32)
        return hmac.compare_digest(key.hex(), expected)
    except (ValueError, TypeError):
        return False


def ensure_password(password):
    if not isinstance(password, str) or len(password) < 10 or len(password) > 128:
        raise HTTPException(400, "Password must be 10–128 characters.")
    return password


def temp_password():
    return "-".join(secrets.token_urlsafe(7) for _ in range(2))


def initialize():
    con = db()
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript("""
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
        updated_at TEXT NOT NULL, PRIMARY KEY(task_id, user_id),
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
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS lesson_progress (
        user_id INTEGER NOT NULL, slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'not_started', notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, slug), FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS mistakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, category TEXT NOT NULL,
        title TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
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
    """)
    if not con.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        for name in ["Alaina", "Aanya", "Kai", "Parker", "Lukas", "Shikha", "Xia", "Akari", "Kaori", "Max", "Lucy"]:
            con.execute("INSERT INTO users(name,username,role,created_at) VALUES(?,?,?,?)",
                        (name, name.lower(), "admin" if name == "Max" else "novice", utcnow()))
        con.execute("INSERT INTO tournaments(title,event_date,details,created_at) VALUES(?,?,?,?)",
                    ("Novice Tournament", "2026-12-13", "Team's first novice tournament. Details and location to be confirmed.", utcnow()))
        con.execute("INSERT INTO announcements(title,body,pinned,created_at) VALUES(?,?,?,?)",
                    ("Welcome to Forum HQ", "Set your weekly availability, check your assignments, and upload practice work here. New members: start with the Training tab. Tournament prep starts now.", 1, utcnow()))
        starter = [
            ("PF round format & speech order", "Guide", "Constructive 4m, crossfire 3m, rebuttal 4m, summary 3m, final focus 2m; 3 minutes of prep per team.", "", "Use the Practice tab for full-round and drill timers."),
            ("Beginner case checklist", "Template", "Build claims with reasoning, evidence, impact, and clear weighing.", "", "Resolution → stance → framework → 2–3 contentions → warrants → credible dated evidence → impact → responses → source list."),
            ("Evidence quality rubric", "Guide", "Prefer qualified authors, transparent methods, recent relevant data, and accurate context.", "", "Check author, publisher, date, methodology, causality, sample size, and whether your card actually supports its claim."),
        ]
        for title, category, description, url, body in starter:
            con.execute("INSERT INTO resources(title,category,description,url,body,created_at) VALUES(?,?,?,?,?,?)",
                        (title,category,description,url,body,utcnow()))
    con.commit()
    con.close()
    # Optional one-time bootstrap for hosted deployments without shell access.
    # Only applies while the seeded Max account has no password.
    initial = os.getenv("INITIAL_ADMIN_PASSWORD", "")
    if initial:
        if len(initial) < 10 or len(initial) > 128:
            raise RuntimeError("INITIAL_ADMIN_PASSWORD must be 10–128 characters.")
        with db() as init_con:
            init_con.execute("UPDATE users SET password_hash=? WHERE username='max' AND password_hash IS NULL", (hash_password(initial),))


initialize()


class Credentials(BaseModel):
    username: str
    password: str


async def get_user(request: Request):
    token = request.cookies.get(COOKIE, "")
    if not token:
        raise HTTPException(401, "Please sign in.")
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with db() as con:
        r = con.execute("""SELECT u.id, u.name, u.username, u.role, u.active, s.csrf
             FROM sessions s JOIN users u ON u.id=s.user_id
             WHERE s.token_hash=? AND s.expires_at>?""", (token_hash,utcnow())).fetchone()
    if not r or not r["active"]:
        raise HTTPException(401, "Session expired. Please sign in again.")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        csrf = request.headers.get("X-CSRF-Token", "")
        if not csrf or not hmac.compare_digest(csrf, r["csrf"]):
            raise HTTPException(403, "Security token missing. Refresh and try again.")
    return dict(r)


def admin(u):
    if u["role"] != "admin":
        raise HTTPException(403, "Admin access required.")


def select_ids(con, ids):
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "Select at least one member.")
    ids = sorted({int(i) for i in ids})
    marks = ",".join("?" for _ in ids)
    count = con.execute(f"SELECT COUNT(*) FROM users WHERE id IN ({marks}) AND active=1",ids).fetchone()[0]
    if count != len(ids):
        raise HTTPException(400, "One or more members are invalid.")
    return ids


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/login")
def login(credentials: Credentials, request: Request):
    username = credentials.username.strip().lower()
    # In-memory attempt limit; deploy behind platform rate limiting too.
    ip = request.client.host if request.client else "unknown"
    key = ip + ":" + username
    now = time.monotonic()
    attempts = [t for t in LOGIN_ATTEMPTS.get(key, []) if now-t < 900]
    if len(attempts) >= 8:
        raise HTTPException(429, "Too many attempts. Try again later.")
    with db() as con:
        r = con.execute("SELECT id,password_hash,active FROM users WHERE username=?", (username,)).fetchone()
        if not r or not r["active"] or not check_password(credentials.password, r["password_hash"]):
            attempts.append(now)
            LOGIN_ATTEMPTS[key] = attempts
            raise HTTPException(401, "Invalid username or password.")
        LOGIN_ATTEMPTS.pop(key, None)
        raw_token = secrets.token_urlsafe(48)
        csrf = secrets.token_urlsafe(32)
        expires = (datetime.now(timezone.utc) + timedelta(days=14)).isoformat(timespec="seconds")
        con.execute("DELETE FROM sessions WHERE expires_at<?", (utcnow(),))
        con.execute("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
                    (hashlib.sha256(raw_token.encode()).hexdigest(),r["id"],csrf,expires))
    res = JSONResponse({"ok": True})
    secure = os.getenv("COOKIE_SECURE", "0") == "1" or request.url.scheme == "https"
    res.set_cookie(COOKIE, raw_token, httponly=True, secure=secure, samesite="lax", max_age=14*86400, path="/")
    res.headers["Cache-Control"] = "no-store"
    return res


@app.get("/api/me")
def me(u=Depends(get_user)):
    return {k: u[k] for k in ("id", "name", "username", "role", "csrf")}


@app.post("/api/logout")
def logout(request: Request, u=Depends(get_user)):
    token = request.cookies.get(COOKIE, "")
    with db() as con:
        con.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    res = JSONResponse({"ok": True})
    res.delete_cookie(COOKIE, path="/")
    return res


@app.post("/api/password")
def change_password(body: dict, request: Request, u=Depends(get_user)):
    current = str(body.get("current", ""))
    new = ensure_password(body.get("password", ""))
    with db() as con:
        r = con.execute("SELECT password_hash FROM users WHERE id=?", (u["id"],)).fetchone()
        if not check_password(current, r["password_hash"]):
            raise HTTPException(400, "Current password is incorrect.")
        con.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new),u["id"]))
        own_token = hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest()
        con.execute("DELETE FROM sessions WHERE user_id=? AND token_hash != ?", (u["id"], own_token))
    return {"ok": True, "message": "Password updated. Sign in again on other devices."}


@app.get("/api/state")
def state(u=Depends(get_user)):
    is_admin = u["role"] == "admin"
    with db() as con:
        members = rows(con,"SELECT id,name,username,role,partner_id,active,(password_hash IS NOT NULL) as has_password FROM users ORDER BY name")
        if not is_admin:
            for m in members:
                m.pop("username", None)
                m.pop("has_password", None)
        if is_admin:
            assignments = rows(con,"SELECT * FROM assignments")
            tasks = rows(con,"SELECT * FROM tasks ORDER BY due_at='',due_at,created_at DESC")
            submissions = rows(con,"SELECT * FROM submissions ORDER BY created_at DESC")
            progress = rows(con,"SELECT * FROM lesson_progress")
            mistakes = rows(con,"SELECT * FROM mistakes ORDER BY created_at DESC")
            feedback = rows(con,"SELECT * FROM feedback ORDER BY created_at DESC")
        else:
            assignments = rows(con,"SELECT * FROM assignments WHERE user_id=?",(u["id"],))
            tasks = rows(con,"SELECT t.* FROM tasks t JOIN assignments a ON a.task_id=t.id WHERE a.user_id=? ORDER BY t.due_at='',t.due_at,t.created_at DESC",(u["id"],))
            submissions = rows(con,"SELECT * FROM submissions WHERE user_id=? ORDER BY created_at DESC",(u["id"],))
            progress = rows(con,"SELECT * FROM lesson_progress WHERE user_id=?",(u["id"],))
            mistakes = rows(con,"SELECT * FROM mistakes WHERE user_id=? ORDER BY created_at DESC",(u["id"],))
            feedback = rows(con,"SELECT * FROM feedback WHERE user_id=? ORDER BY created_at DESC",(u["id"],))
        return {
            "members":members, "availability":rows(con,"SELECT a.* FROM availability a JOIN users u ON u.id=a.user_id WHERE u.active=1"),
            "announcements":rows(con,"SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC"),
            "resources":rows(con,"SELECT * FROM resources ORDER BY created_at DESC"),
            "tournaments":rows(con,"SELECT * FROM tournaments ORDER BY event_date,event_time"),
            "tasks":tasks,"assignments":assignments,"submissions":submissions,
            "progress":progress,"mistakes":mistakes,"feedback":feedback,
            "cases":rows(con,"SELECT * FROM cases ORDER BY created_at DESC")
        }


@app.put("/api/availability")
def availability(body: dict, u=Depends(get_user)):
    slots = body.get("slots")
    if not isinstance(slots,list) or len(slots)>70:
        raise HTTPException(400,"Invalid availability slots.")
    valid = set()
    for item in slots:
        if not isinstance(item,(list,tuple)) or len(item)!=2:
            raise HTTPException(400,"Invalid slot.")
        d,h = item
        if type(d) is not int or type(h) is not int or d not in range(7) or (h not in (range(16,20) if d<5 else range(10,20))):
            raise HTTPException(400,"Availability must be in school-day or weekend hours.")
        valid.add((d,h))
    with db() as con:
        con.execute("DELETE FROM availability WHERE user_id=?",(u["id"],))
        con.executemany("INSERT INTO availability(user_id,day,hour) VALUES(?,?,?)",[(u["id"],d,h) for d,h in valid])
    return {"ok":True,"count":len(valid)}


@app.post("/api/members")
def add_member(body: dict,u=Depends(get_user)):
    admin(u)
    name=text(body.get("name"),80,True)
    username=text(body.get("username"),40,True).lower()
    if not re.fullmatch(r"[a-z0-9_.-]{2,40}",username):
        raise HTTPException(400,"Username must be 2–40 lowercase letters, digits, dots, underscores or hyphens.")
    role=body.get("role","novice")
    if role not in VALID_ROLES: raise HTTPException(400,"Invalid role.")
    password=temp_password()
    try:
        with db() as con:
            cur=con.execute("INSERT INTO users(name,username,password_hash,role,created_at) VALUES(?,?,?,?,?)",(name,username,hash_password(password),role,utcnow()))
            return {"id":cur.lastrowid,"username":username,"temporary_password":password}
    except sqlite3.IntegrityError:
        raise HTTPException(409,"This username is already taken.")


@app.patch("/api/members/{uid}")
def edit_member(uid:int,body:dict,u=Depends(get_user)):
    admin(u)
    with db() as con:
        m=con.execute("SELECT * FROM users WHERE id=?",(uid,)).fetchone()
        if not m: raise HTTPException(404,"Member not found.")
        fields=[]; vals=[]
        if "name" in body:
            fields.append("name=?");vals.append(text(body["name"],80,True))
        if "role" in body:
            role=body["role"]
            if role not in VALID_ROLES:raise HTTPException(400,"Invalid role.")
            if uid == u["id"] and role != "admin":raise HTTPException(400,"You cannot remove your own admin role.")
            fields.append("role=?");vals.append(role)
        if "active" in body:
            if uid == u["id"] and not body["active"]:raise HTTPException(400,"Cannot deactivate yourself.")
            fields.append("active=?");vals.append(1 if body["active"] else 0)
            if not body["active"]: con.execute("DELETE FROM sessions WHERE user_id=?",(uid,))
        if "partner_id" in body:
            partner_id=body["partner_id"]
            if partner_id in ("",None): partner_id=None
            else:
                partner_id=int(partner_id)
                if partner_id==uid or not con.execute("SELECT 1 FROM users WHERE id=? AND active=1",(partner_id,)).fetchone():
                    raise HTTPException(400,"Choose another active member as partner.")
            prev=con.execute("SELECT partner_id FROM users WHERE id=?",(uid,)).fetchone()[0]
            if prev: con.execute("UPDATE users SET partner_id=NULL WHERE id=?",(prev,))
            if partner_id:
                other_prev=con.execute("SELECT partner_id FROM users WHERE id=?",(partner_id,)).fetchone()[0]
                if other_prev:con.execute("UPDATE users SET partner_id=NULL WHERE id=?",(other_prev,))
                con.execute("UPDATE users SET partner_id=? WHERE id=?",(uid,partner_id))
            fields.append("partner_id=?");vals.append(partner_id)
        if fields:
            con.execute(f"UPDATE users SET {','.join(fields)} WHERE id=?",(*vals,uid))
    return {"ok":True}


@app.post("/api/members/{uid}/reset-password")
def reset_password(uid:int,u=Depends(get_user)):
    admin(u)
    if uid == u["id"]:
        raise HTTPException(400,"Use Change my password for your own account.")
    with db() as con:
        if not con.execute("SELECT 1 FROM users WHERE id=?",(uid,)).fetchone():raise HTTPException(404,"Member not found.")
        password=temp_password()
        con.execute("UPDATE users SET password_hash=?,active=1 WHERE id=?",(hash_password(password),uid))
        con.execute("DELETE FROM sessions WHERE user_id=?",(uid,))
        return {"temporary_password":password}


@app.post("/api/tasks")
def create_task(body:dict,u=Depends(get_user)):
    admin(u)
    title=text(body.get("title"),180,True)
    desc=text(body.get("description"),6000)
    due=valid_date(body.get("due_at",""))
    priority=body.get("priority","normal")
    if priority not in {"low","normal","high"}:raise HTTPException(400,"Invalid priority.")
    with db() as con:
        member_ids=select_ids(con,body.get("assignees",[]))
        cur=con.execute("INSERT INTO tasks(title,description,due_at,priority,created_by,created_at) VALUES(?,?,?,?,?,?)",(title,desc,due,priority,u["id"],utcnow()))
        con.executemany("INSERT INTO assignments(task_id,user_id,updated_at) VALUES(?,?,?)",[(cur.lastrowid,i,utcnow()) for i in member_ids])
        return {"ok":True,"id":cur.lastrowid}


@app.patch("/api/tasks/{tid}")
def edit_task(tid:int,body:dict,u=Depends(get_user)):
    admin(u)
    with db() as con:
        if not con.execute("SELECT 1 FROM tasks WHERE id=?",(tid,)).fetchone():raise HTTPException(404,"Task not found.")
        updates=[];values=[]
        for field,maxlen in [("title",180),("description",6000)]:
            if field in body:updates.append(field+"=?");values.append(text(body[field],maxlen,field=="title"))
        if "due_at" in body:updates.append("due_at=?");values.append(valid_date(body["due_at"]))
        if "priority" in body:
            if body["priority"] not in {"low","normal","high"}:raise HTTPException(400,"Invalid priority.")
            updates.append("priority=?");values.append(body["priority"])
        if updates:con.execute("UPDATE tasks SET "+",".join(updates)+" WHERE id=?",(*values,tid))
        if "assignees" in body:
            ids=select_ids(con,body["assignees"])
            marks=",".join("?" for _ in ids)
            con.execute(f"DELETE FROM assignments WHERE task_id=? AND user_id NOT IN ({marks})",(tid,*ids))
            con.executemany("INSERT OR IGNORE INTO assignments(task_id,user_id,updated_at) VALUES(?,?,?)",[(tid,i,utcnow()) for i in ids])
    return {"ok":True}


@app.delete("/api/tasks/{tid}")
def delete_task(tid:int,u=Depends(get_user)):
    admin(u)
    with db() as con:con.execute("DELETE FROM tasks WHERE id=?",(tid,))
    return {"ok":True}


@app.patch("/api/tasks/{tid}/status")
def task_status(tid:int,body:dict,u=Depends(get_user)):
    status=body.get("status")
    if status not in VALID_STATUSES:raise HTTPException(400,"Invalid status.")
    uid=int(body.get("user_id",u["id"])) if u["role"]=="admin" else u["id"]
    note=text(body.get("note",""),2000)
    with db() as con:
        cur=con.execute("UPDATE assignments SET status=?,note=?,updated_at=? WHERE task_id=? AND user_id=?",(status,note,utcnow(),tid,uid))
        if not cur.rowcount:raise HTTPException(404,"Assignment not found.")
    return {"ok":True}


@app.post("/api/submissions")
async def create_submission(title: str=Form(...),notes: str=Form(""),url: str=Form(""),task_id: str=Form(""),attachment: Optional[UploadFile]=File(None),u=Depends(get_user)):
    title=text(title,180,True)
    notes=text(notes,6000)
    url=clean_url(url)
    tid=int(task_id) if task_id.strip() else None
    if not url and (not attachment or not attachment.filename):
        raise HTTPException(400,"Attach a file or paste a link.")
    if tid:
        with db() as con:
            if u["role"] != "admin" and not con.execute("SELECT 1 FROM assignments WHERE task_id=? AND user_id=?",(tid,u["id"])).fetchone():
                raise HTTPException(403,"This assignment is not yours.")
            if not con.execute("SELECT 1 FROM tasks WHERE id=?",(tid,)).fetchone():raise HTTPException(404,"Task not found.")
    name=""; stored=""; size=0; mime=""
    if attachment and attachment.filename:
        name=Path(attachment.filename.replace("\\","/")).name
        name=text(name,180,True)
        suffix=Path(name).suffix.lower()
        if suffix not in ALLOWED_SUFFIXES:
            raise HTTPException(400,"Unsupported file type. Use PDF, Office documents, images, audio or video.")
        stored=uuid.uuid4().hex+suffix
        mime=attachment.content_type or "application/octet-stream"
        target=UPLOADS/stored
        try:
            with target.open("wb") as f:
                while chunk:=await attachment.read(1024*1024):
                    size+=len(chunk)
                    if size>MAX_UPLOAD: raise HTTPException(413,f"File exceeds {MAX_UPLOAD // (1024*1024)} MB limit.")
                    f.write(chunk)
        except Exception:
            target.unlink(missing_ok=True)
            raise
    with db() as con:
        cur=con.execute("""INSERT INTO submissions(user_id,task_id,title,notes,url,filename,stored_name,mime,size,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)""",(u["id"],tid,title,notes,url,name,stored,mime,size,utcnow()))
        if tid:con.execute("UPDATE assignments SET status='submitted',updated_at=? WHERE task_id=? AND user_id=?",(utcnow(),tid,u["id"]))
    return {"ok":True,"id":cur.lastrowid}


@app.get("/api/submissions/{sid}/download")
def download(sid:int,u=Depends(get_user)):
    with db() as con:s=con.execute("SELECT * FROM submissions WHERE id=?",(sid,)).fetchone()
    if not s:raise HTTPException(404,"Submission not found.")
    if u["role"]!="admin" and s["user_id"]!=u["id"]:raise HTTPException(403,"Access denied.")
    if not s["stored_name"]:raise HTTPException(404,"No file attached.")
    target=UPLOADS/s["stored_name"]
    if not target.is_file():raise HTTPException(404,"File missing from server storage.")
    return FileResponse(target,media_type="application/octet-stream",filename=s["filename"],headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"})


@app.patch("/api/submissions/{sid}")
def review_submission(sid:int,body:dict,u=Depends(get_user)):
    admin(u)
    status=body.get("status","reviewed")
    if status not in {"new","reviewed","revision_requested"}:raise HTTPException(400,"Invalid review status.")
    feedback=text(body.get("feedback",""),4000)
    with db() as con:
        c=con.execute("UPDATE submissions SET status=?,feedback=? WHERE id=?",(status,feedback,sid))
        if not c.rowcount:raise HTTPException(404,"Submission not found.")
    return {"ok":True}


@app.post("/api/announcements")
def new_announcement(body:dict,u=Depends(get_user)):
    admin(u)
    with db() as con:
        con.execute("INSERT INTO announcements(title,body,pinned,created_by,created_at) VALUES(?,?,?,?,?)",(text(body.get("title"),180,True),text(body.get("body"),8000,True),int(bool(body.get("pinned"))),u["id"],utcnow()))
    return {"ok":True}


@app.delete("/api/announcements/{rid}")
def delete_announcement(rid:int,u=Depends(get_user)):
    admin(u)
    with db() as con:con.execute("DELETE FROM announcements WHERE id=?",(rid,))
    return {"ok":True}


@app.post("/api/resources")
def new_resource(body:dict,u=Depends(get_user)):
    admin(u)
    title=text(body.get("title"),180,True)
    cat=text(body.get("category","Guide"),50,True)
    with db() as con:
        con.execute("INSERT INTO resources(title,category,description,url,body,created_by,created_at) VALUES(?,?,?,?,?,?,?)",(title,cat,text(body.get("description"),500),clean_url(body.get("url")),text(body.get("body"),12000),u["id"],utcnow()))
    return {"ok":True}


@app.delete("/api/resources/{rid}")
def delete_resource(rid:int,u=Depends(get_user)):
    admin(u)
    with db() as con:con.execute("DELETE FROM resources WHERE id=?",(rid,))
    return {"ok":True}


@app.post("/api/tournaments")
def new_tournament(body:dict,u=Depends(get_user)):
    admin(u)
    date=valid_date(body.get("event_date",""))
    if not date or "T" in date:raise HTTPException(400,"Choose a tournament date.")
    with db() as con:
        con.execute("INSERT INTO tournaments(title,event_date,event_time,location,details,link,created_at) VALUES(?,?,?,?,?,?,?)",(text(body.get("title"),180,True),date,text(body.get("event_time"),40),text(body.get("location"),200),text(body.get("details"),5000),clean_url(body.get("link")),utcnow()))
    return {"ok":True}


@app.delete("/api/tournaments/{tid}")
def delete_tournament(tid:int,u=Depends(get_user)):
    admin(u)
    with db() as con:con.execute("DELETE FROM tournaments WHERE id=?",(tid,))
    return {"ok":True}


@app.put("/api/lessons/{slug}")
def lesson_progress(slug:str,body:dict,u=Depends(get_user)):
    if not re.fullmatch(r"[a-z0-9-]{3,60}",slug):raise HTTPException(400,"Invalid lesson.")
    status=body.get("status","learning")
    if status not in LESSON_STATUSES:raise HTTPException(400,"Invalid lesson status.")
    notes=text(body.get("notes"),2000)
    with db() as con:
        con.execute("""INSERT INTO lesson_progress(user_id,slug,status,notes,updated_at) VALUES(?,?,?,?,?)
            ON CONFLICT(user_id,slug) DO UPDATE SET status=excluded.status,notes=excluded.notes,updated_at=excluded.updated_at""",(u["id"],slug,status,notes,utcnow()))
    return {"ok":True}


@app.post("/api/mistakes")
def new_mistake(body:dict,u=Depends(get_user)):
    uid=int(body.get("user_id",u["id"])) if u["role"]=="admin" else u["id"]
    category=text(body.get("category","Other"),80,True)
    title=text(body.get("title"),200,True)
    with db() as con:
        if not con.execute("SELECT 1 FROM users WHERE id=?",(uid,)).fetchone():raise HTTPException(404,"Member not found.")
        con.execute("INSERT INTO mistakes(user_id,category,title,context,created_at,updated_at) VALUES(?,?,?,?,?,?)",(uid,category,title,text(body.get("context"),4000),utcnow(),utcnow()))
    return {"ok":True}


@app.patch("/api/mistakes/{mid}")
def edit_mistake(mid:int,body:dict,u=Depends(get_user)):
    status=body.get("status")
    if status not in MISTAKE_STATUSES:raise HTTPException(400,"Invalid review status.")
    with db() as con:
        m=con.execute("SELECT user_id FROM mistakes WHERE id=?",(mid,)).fetchone()
        if not m:raise HTTPException(404,"Review item not found.")
        if u["role"]!="admin" and m["user_id"]!=u["id"]:raise HTTPException(403,"Access denied.")
        con.execute("UPDATE mistakes SET status=?,updated_at=? WHERE id=?",(status,utcnow(),mid))
    return {"ok":True}


@app.post("/api/feedback")
def new_feedback(body:dict,u=Depends(get_user)):
    admin(u)
    uid=int(body.get("user_id",0))
    score=int(body.get("score",3))
    if not 1<=score<=5:raise HTTPException(400,"Score must be 1–5.")
    with db() as con:
        if not con.execute("SELECT 1 FROM users WHERE id=?",(uid,)).fetchone():raise HTTPException(404,"Member not found.")
        con.execute("INSERT INTO feedback(user_id,author_id,category,score,positive,focus,created_at) VALUES(?,?,?,?,?,?,?)",(uid,u["id"],text(body.get("category","General"),80),score,text(body.get("positive"),2500),text(body.get("focus"),2500),utcnow()))
    return {"ok":True}


@app.post("/api/cases")
def new_case(body:dict,u=Depends(get_user)):
    title=text(body.get("title"),180,True)
    side=body.get("side","Pro")
    if side not in {"Pro","Con","Both"}:raise HTTPException(400,"Invalid side.")
    status=body.get("status","draft")
    if status not in CASE_STATUSES:raise HTTPException(400,"Invalid status.")
    with db() as con:
        con.execute("INSERT INTO cases(title,side,category,argument,status,source_url,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",(title,side,text(body.get("category","Contention"),80),text(body.get("argument"),12000),status,clean_url(body.get("source_url")),u["id"],utcnow()))
    return {"ok":True}


@app.patch("/api/cases/{cid}")
def edit_case(cid:int,body:dict,u=Depends(get_user)):
    with db() as con:
        r=con.execute("SELECT * FROM cases WHERE id=?",(cid,)).fetchone()
        if not r:raise HTTPException(404,"Argument not found.")
        if u["role"]!="admin" and r["created_by"]!=u["id"]:raise HTTPException(403,"Only the author or admin may edit.")
        fields=[];values=[]
        for f,maxlen in [("title",180),("category",80),("argument",12000)]:
            if f in body: fields.append(f+"=?");values.append(text(body[f],maxlen,f=="title"))
        if "source_url" in body:fields.append("source_url=?");values.append(clean_url(body["source_url"]))
        if "status" in body:
            if body["status"] not in CASE_STATUSES:raise HTTPException(400,"Invalid status.")
            fields.append("status=?");values.append(body["status"])
        if fields: con.execute("UPDATE cases SET "+",".join(fields)+" WHERE id=?",(*values,cid))
    return {"ok":True}


@app.delete("/api/cases/{cid}")
def delete_case(cid:int,u=Depends(get_user)):
    with db() as con:
        r=con.execute("SELECT created_by FROM cases WHERE id=?",(cid,)).fetchone()
        if not r:raise HTTPException(404,"Argument not found.")
        if u["role"]!="admin" and r["created_by"]!=u["id"]:raise HTTPException(403,"Not your argument.")
        con.execute("DELETE FROM cases WHERE id=?",(cid,))
    return {"ok":True}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code,content={"detail":exc.detail},headers=exc.headers or {})


@app.middleware("http")
async def add_security_headers(request:Request,call_next):
    response=await call_next(request)
    response.headers["X-Content-Type-Options"]="nosniff"
    response.headers["Referrer-Policy"]="strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"]="DENY"
    response.headers["Content-Security-Policy"]="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"]="no-store"
    return response
