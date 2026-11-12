/* Forum HQ — Cloudflare Workers + D1 backend.
 * The API shapes, roles and original static frontend are preserved from FastAPI.
 * No R2, KV, paid service, external HTTP calls, or public registration.
 */
const COOKIE = 'forum_session';
const SESSION_DAYS = 14;
const MAX_UPLOAD = 50 * 1024 * 1024;
const FILE_PART = 256 * 1024; // Small per-request D1 BLOBs work better on the Free CPU tier.
const MAX_DIRECT_UPLOAD = 1024 * 1024; // Larger files transparently use browser chunked upload.
const MAX_DB_MEDIA = 350 * 1024 * 1024; // Headroom under 500 MB free DB cap.
const VALID_ROLES = new Set(['admin', 'officer', 'novice']);
const VALID_STATUSES = new Set(['todo', 'in_progress', 'submitted', 'done']);
const LESSON_STATUSES = new Set(['not_started', 'learning', 'practicing', 'confident']);
const MISTAKE_STATUSES = new Set(['open', 'practicing', 'resolved']);
const CASE_STATUSES = new Set(['draft', 'needs_review', 'ready']);
const ALLOWED_SUFFIXES = new Set(['.pdf','.doc','.docx','.txt','.rtf','.ppt','.pptx','.xls','.xlsx','.csv','.png','.jpg','.jpeg','.gif','.webp','.mp4','.mov','.webm','.mp3','.m4a','.wav']);
const enc = new TextEncoder();
class HttpError extends Error { constructor(status, detail) { super(detail); this.status = status; this.detail = detail; } }
const fail = (status, detail) => { throw new HttpError(status, detail); };
const now = () => new Date().toISOString();
const randomToken = (length = 48) => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
};
const hex = bytes => Array.from(new Uint8Array(bytes), b=>b.toString(16).padStart(2,'0')).join('');
async function sha256(value) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(value))); }
const b64url = array => {
  let s=''; for(const b of array)s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const from64url = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)), c=>c.charCodeAt(0));
async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', enc.encode(password), {name:'PBKDF2'}, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:100000},base,256);
  return `pbkdf2-sha256$100000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}
function safeEqual(a,b) {
  if(typeof a!=='string'||typeof b!=='string') return false;
  let diff=a.length^b.length;
  const n=Math.max(a.length,b.length);
  for(let i=0;i<n;i++) diff |= (a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);
  return diff===0;
}
async function passwordMatches(password,hash) {
  if(!hash || typeof password!=='string') return false;
  try {
    const [scheme, count, salt64, expected64] = hash.split('$');
    if(scheme!=='pbkdf2-sha256' || !/^\d+$/.test(count)) return false;
    const iterations=Number(count);
    if(iterations<100000||iterations>100000) return false;
    const salt=from64url(salt64);
    const base=await crypto.subtle.importKey('raw',enc.encode(password),{name:'PBKDF2'},false,['deriveBits']);
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},base,256);
    return safeEqual(b64url(new Uint8Array(bits)),expected64);
  } catch { return false; }
}
function ensurePassword(v) {
  if(typeof v!=='string'||v.length<10||v.length>128) fail(400,'Password must be 10–128 characters.');
  return v;
}
const tempPassword = () => `${randomToken(7)}-${randomToken(7)}`;
function txt(value,max=500,required=false) {
  const s=String(value??'').trim();
  if(s.length>max || (required&&!s)) fail(400,`Enter ${required?'a value':'shorter text'} (max ${max} characters).`);
  return s;
}
function cleanUrl(value) {
  const s=txt(value,2000);
  if(s){try{const u=new URL(s);if(!['http:','https:'].includes(u.protocol))throw 0;}catch{fail(400,'Please use an https:// or http:// link.');}}
  return s;
}
function validDate(value) {
  if(!value) return '';
  const s=String(value);
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)){
    const d=new Date(s+'T12:00:00Z'); if(!Number.isFinite(d.valueOf())||d.toISOString().slice(0,10)!==s) fail(400,'Invalid date.');return s;
  }
  if(/^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(new Date(s).valueOf())) return s;
  fail(400,'Invalid date.');
}
function positiveInt(v, what='ID') {const n=Number(v);if(!Number.isSafeInteger(n)||n<1) fail(400,`Invalid ${what}.`);return n;}
async function one(db, sql, ...args) { return await db.prepare(sql).bind(...args).first(); }
async function all(db, sql, ...args) {return (await db.prepare(sql).bind(...args).all()).results || [];}
async function run(db, sql, ...args) {return await db.prepare(sql).bind(...args).run();}
const json = (data,status=200,extra={})=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...extra}});
function checkAdmin(user) {if(user.role!=='admin') fail(403,'Admin access required.');}
function sessionCookie(token){return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${14*86400}`;}
const expireCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
function readCookie(request) {
  const cookies=request.headers.get('Cookie')||'';
  const item=cookies.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='));
  return item ? item.slice(COOKIE.length+1) : '';
}
async function requireUser(request, db) {
  const token=readCookie(request);
  if(!token) fail(401,'Please sign in.');
  const user=await one(db,`SELECT u.id,u.name,u.username,u.role,u.active,s.csrf
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`,await sha256(token),now());
  if(!user || !user.active) fail(401,'Session expired. Please sign in again.');
  if(!['GET','HEAD','OPTIONS'].includes(request.method) && !safeEqual(request.headers.get('X-CSRF-Token')||'',user.csrf)){
    fail(403,'Security token missing. Refresh and try again.');
  }
  return user;
}
async function selectIds(db,ids) {
  if(!Array.isArray(ids)||!ids.length) fail(400,'Select at least one member.');
  const unique=[...new Set(ids.map(i=>positiveInt(i,'member')))].sort((a,b)=>a-b);
  if(unique.length>200) fail(400,'Too many members selected.');
  const query=`SELECT COUNT(*) AS n FROM users WHERE id IN (${unique.map(()=>'?').join(',')}) AND active=1`;
  const result=await one(db,query,...unique);
  if(result.n!==unique.length)fail(400,'One or more members are invalid.');
  return unique;
}
async function bodyJson(request) {
  try{const x=await request.json();if(!x||Array.isArray(x)||typeof x!=='object')throw 0;return x;}
  catch { fail(400,'Invalid JSON request.'); }
}
function responseSecurity(response, request) {
  const h=new Headers(response.headers);
  h.set('X-Content-Type-Options','nosniff');
  h.set('Referrer-Policy','no-referrer');
  h.set('X-Frame-Options','DENY');
  h.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if(new URL(request.url).protocol==='https:')h.set('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}
async function apiRoute(request,env,path) {
  const db=env.DB, method=request.method;
  const hit=(verb,regex)=>method===verb && regex.test(path);
  let m;
  if(method==='GET' && path==='/health') return json({status:'ok'});
  if(method==='POST'&&path==='/api/login') {
    const b=await bodyJson(request);
    const username=String(b.username??'').trim().toLowerCase();
    const password=String(b.password??'');
    if(username.length>80 || password.length>256) fail(401,'Invalid username or password.');
    const source=request.headers.get('CF-Connecting-IP')||'unknown';
    const key=await sha256(`${source.toLowerCase()}|${username}`);
    const attempt=await one(db,'SELECT failures,expires_at FROM login_attempts WHERE key=?',key);
    if(attempt && attempt.expires_at>now() && attempt.failures>=8) fail(429,'Too many attempts. Try again later.');
    const account=await one(db,'SELECT id,password_hash,active FROM users WHERE username=?',username);
    if(!account || !account.active || !await passwordMatches(password,account.password_hash)){
      const failures=attempt&&attempt.expires_at>now()?attempt.failures+1:1;
      const expires=new Date(Date.now()+15*60_000).toISOString();
      await run(db,`INSERT INTO login_attempts(key,failures,expires_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,expires_at=excluded.expires_at`,key,failures,expires);
      fail(401,'Invalid username or password.');
    }
    await run(db,'DELETE FROM login_attempts WHERE key=?',key);
    const token=randomToken(), csrf=randomToken(24);
    const expires=new Date(Date.now()+SESSION_DAYS*86400000).toISOString();
    await run(db,'INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)',await sha256(token),account.id,csrf,expires);
    return json({ok:true},200,{'Set-Cookie':sessionCookie(token)});
  }
  if(!path.startsWith('/api/')) fail(404,'Not found.');
  const user=await requireUser(request,db);
  if(method==='GET'&&path==='/api/me')return json({id:user.id,name:user.name,username:user.username,role:user.role,csrf:user.csrf});
  if(method==='POST'&&path==='/api/logout'){
    await run(db,'DELETE FROM sessions WHERE token_hash=?',await sha256(readCookie(request)));
    return json({ok:true},200,{'Set-Cookie':expireCookie()});
  }
  if(method==='POST'&&path==='/api/password') {
    const b=await bodyJson(request),newPassword=ensurePassword(b.password),current=String(b.current??'');
    const stored=await one(db,'SELECT password_hash FROM users WHERE id=?',user.id);
    if(!await passwordMatches(current,stored?.password_hash))fail(400,'Current password is incorrect.');
    await run(db,'UPDATE users SET password_hash=? WHERE id=?',await passwordHash(newPassword),user.id);
    await run(db,'DELETE FROM sessions WHERE user_id=? AND token_hash != ?',user.id,await sha256(readCookie(request)));
    return json({ok:true,message:'Password updated. Sign in again on other devices.'});
  }
  if(method==='GET'&&path==='/api/state') {
    const administrator=user.role==='admin';
    const members=await all(db,`SELECT id,name,username,role,partner_id,active,
      (password_hash IS NOT NULL) AS has_password FROM users ORDER BY name`);
    if(!administrator)members.forEach(m=>{delete m.username;delete m.has_password;});
    // D1 Free allows 50 queries/invocation and limits concurrent connections.
    // One batch gives a consistent, efficient snapshot without 11 simultaneous connections.
    const queries=[
      db.prepare('SELECT a.* FROM availability a JOIN users u ON u.id=a.user_id WHERE u.active=1'),
      db.prepare('SELECT * FROM announcements ORDER BY pinned DESC,created_at DESC'),
      db.prepare('SELECT * FROM resources ORDER BY created_at DESC'),
      db.prepare('SELECT * FROM tournaments ORDER BY event_date,event_time'),
      administrator ? db.prepare("SELECT * FROM tasks ORDER BY due_at='',due_at,created_at DESC"):
        db.prepare("SELECT t.* FROM tasks t JOIN assignments a ON a.task_id=t.id WHERE a.user_id=? ORDER BY t.due_at='',t.due_at,t.created_at DESC").bind(user.id),
      administrator ? db.prepare('SELECT * FROM assignments') : db.prepare('SELECT * FROM assignments WHERE user_id=?').bind(user.id),
      administrator ? db.prepare("SELECT * FROM submissions WHERE upload_state='ready' ORDER BY created_at DESC") : db.prepare("SELECT * FROM submissions WHERE upload_state='ready' AND user_id=? ORDER BY created_at DESC").bind(user.id),
      administrator ? db.prepare('SELECT * FROM lesson_progress') : db.prepare('SELECT * FROM lesson_progress WHERE user_id=?').bind(user.id),
      administrator ? db.prepare('SELECT * FROM mistakes ORDER BY created_at DESC') : db.prepare('SELECT * FROM mistakes WHERE user_id=? ORDER BY created_at DESC').bind(user.id),
      administrator ? db.prepare('SELECT * FROM feedback ORDER BY created_at DESC') : db.prepare('SELECT * FROM feedback WHERE user_id=? ORDER BY created_at DESC').bind(user.id),
      db.prepare('SELECT * FROM cases ORDER BY created_at DESC')
    ];
    const lists=(await db.batch(queries)).map(result=>result.results||[]);
    const [availability,announcements,resources,tournaments,tasks,assignments,submissions,progress,mistakes,feedback,cases]=lists;
    return json({members,availability,announcements,resources,tournaments,tasks,assignments,submissions,progress,mistakes,feedback,cases});
  }
  if(method==='PUT'&&path==='/api/availability') {
    const b=await bodyJson(request);
    if(!Array.isArray(b.slots)||b.slots.length>70)fail(400,'Invalid availability slots.');
    const valid=new Map();
    for(const item of b.slots){
      if(!Array.isArray(item)||item.length!==2)fail(400,'Invalid slot.');
      const [d,h]=item;
      if(!Number.isInteger(d)||!Number.isInteger(h)||d<0||d>6||h<(d<5?16:10)||h>=20)fail(400,'Availability must be in school-day or weekend hours.');
      valid.set(`${d},${h}`,[d,h]);
    }
    await db.batch([db.prepare('DELETE FROM availability WHERE user_id=?').bind(user.id),
      ...[...valid.values()].map(([d,h])=>db.prepare('INSERT INTO availability(user_id,day,hour) VALUES(?,?,?)').bind(user.id,d,h))]);
    return json({ok:true,count:valid.size});
  }
  if(method==='POST'&&path==='/api/members') {
    checkAdmin(user);const b=await bodyJson(request);
    const name=txt(b.name,80,true),username=txt(b.username,40,true).toLowerCase(),role=b.role||'novice';
    if(!/^[a-z0-9_.-]{2,40}$/.test(username))fail(400,'Username must be 2–40 lowercase letters, digits, dots, underscores or hyphens.');
    if(!VALID_ROLES.has(role))fail(400,'Invalid role.');
    if(await one(db,'SELECT id FROM users WHERE username=?',username))fail(409,'This username is already taken.');
    const password=tempPassword();
    try {
      const row=await one(db,`INSERT INTO users(name,username,password_hash,role,created_at)
        VALUES(?,?,?,?,?) RETURNING id`,name,username,await passwordHash(password),role,now());
      return json({id:row.id,username,temporary_password:password});
    }catch(e){if(/UNIQUE/i.test(String(e)))fail(409,'This username is already taken.');throw e;}
  }
  if((m=path.match(/^\/api\/members\/(\d+)$/))&&method==='PATCH'){
    checkAdmin(user);const uid=positiveInt(m[1]);const b=await bodyJson(request);
    const member=await one(db,'SELECT * FROM users WHERE id=?',uid);
    if(!member)fail(404,'Member not found.');
    const updates=[],values=[];
    if('name' in b){updates.push('name=?');values.push(txt(b.name,80,true));}
    if('role' in b){if(!VALID_ROLES.has(b.role))fail(400,'Invalid role.');if(uid===user.id&&b.role!=='admin')fail(400,'You cannot remove your own admin role.');updates.push('role=?');values.push(b.role);}
    if('active' in b){if(uid===user.id&&!b.active)fail(400,'Cannot deactivate yourself.');updates.push('active=?');values.push(b.active?1:0);if(!b.active)await run(db,'DELETE FROM sessions WHERE user_id=?',uid);}
    if('partner_id' in b) {
      let pid=b.partner_id;
      if(pid===''||pid===null||pid===undefined)pid=null;
      else {
        pid=positiveInt(pid,'partner');
        if(pid===uid||!await one(db,'SELECT 1 AS ok FROM users WHERE id=? AND active=1',pid))fail(400,'Choose another active member as partner.');
      }
      if(member.partner_id) await run(db,'UPDATE users SET partner_id=NULL WHERE id=?',member.partner_id);
      if(pid){const prior=await one(db,'SELECT partner_id FROM users WHERE id=?',pid);
        if(prior?.partner_id)await run(db,'UPDATE users SET partner_id=NULL WHERE id=?',prior.partner_id);
        await run(db,'UPDATE users SET partner_id=? WHERE id=?',uid,pid);
      }
      updates.push('partner_id=?');values.push(pid);
    }
    if(updates.length)await run(db,`UPDATE users SET ${updates.join(',')} WHERE id=?`,...values,uid);
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/members\/(\d+)\/reset-password$/))&&method==='POST'){
    checkAdmin(user);const uid=positiveInt(m[1]);
    if(uid===user.id)fail(400,'Use Change my password for your own account.');
    if(!await one(db,'SELECT id FROM users WHERE id=?',uid))fail(404,'Member not found.');
    const password=tempPassword();
    await db.batch([
      db.prepare('UPDATE users SET password_hash=?,active=1 WHERE id=?').bind(await passwordHash(password),uid),
      db.prepare('DELETE FROM sessions WHERE user_id=?').bind(uid)
    ]);
    return json({temporary_password:password});
  }
  if(method==='POST'&&path==='/api/tasks') {
    checkAdmin(user);const b=await bodyJson(request);
    const title=txt(b.title,180,true),description=txt(b.description,6000),due_at=validDate(b.due_at),priority=b.priority||'normal';
    if(!['low','normal','high'].includes(priority))fail(400,'Invalid priority.');
    const ids=await selectIds(db,b.assignees);
    const task=await one(db,'INSERT INTO tasks(title,description,due_at,priority,created_by,created_at) VALUES(?,?,?,?,?,?) RETURNING id',title,description,due_at,priority,user.id,now());
    await db.batch(ids.map(uid=>db.prepare('INSERT INTO assignments(task_id,user_id,updated_at) VALUES(?,?,?)').bind(task.id,uid,now())));
    return json({ok:true,id:task.id});
  }
  if((m=path.match(/^\/api\/tasks\/(\d+)$/))&&method==='PATCH'){
    checkAdmin(user);const tid=positiveInt(m[1]),b=await bodyJson(request);
    if(!await one(db,'SELECT id FROM tasks WHERE id=?',tid))fail(404,'Task not found.');
    const columns=[],args=[];
    for(const [field,len] of [['title',180],['description',6000]])if(field in b){columns.push(`${field}=?`);args.push(txt(b[field],len,field==='title'));}
    if('due_at' in b){columns.push('due_at=?');args.push(validDate(b.due_at));}
    if('priority' in b){if(!['low','normal','high'].includes(b.priority))fail(400,'Invalid priority.');columns.push('priority=?');args.push(b.priority);}
    if(columns.length)await run(db,`UPDATE tasks SET ${columns.join(',')} WHERE id=?`,...args,tid);
    if('assignees' in b){const ids=await selectIds(db,b.assignees);
      await db.batch([db.prepare(`DELETE FROM assignments WHERE task_id=? AND user_id NOT IN (${ids.map(()=>'?').join(',')})`).bind(tid,...ids),
        ...ids.map(uid=>db.prepare('INSERT OR IGNORE INTO assignments(task_id,user_id,updated_at) VALUES(?,?,?)').bind(tid,uid,now()))]);
    }
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/tasks\/(\d+)$/))&&method==='DELETE'){
    checkAdmin(user);await run(db,'DELETE FROM tasks WHERE id=?',positiveInt(m[1]));return json({ok:true});
  }
  if((m=path.match(/^\/api\/tasks\/(\d+)\/status$/))&&method==='PATCH'){
    const tid=positiveInt(m[1]),b=await bodyJson(request);
    if(!VALID_STATUSES.has(b.status))fail(400,'Invalid status.');
    const uid=user.role==='admin'&&b.user_id!==undefined?positiveInt(b.user_id,'member'):user.id;
    const result=await run(db,'UPDATE assignments SET status=?,note=?,updated_at=? WHERE task_id=? AND user_id=?',b.status,txt(b.note,2000),now(),tid,uid);
    if(!result.meta?.changes)fail(404,'Assignment not found.');
    return json({ok:true});
  }
  // Resumable-style chunked uploads: keeps every Worker request well below Free CPU limits.
  // The original submission form and 50 MB/file allowance remain unchanged.
  if(method==='POST'&&path==='/api/submissions/start') {
    const b=await bodyJson(request);
    const title=txt(b.title,180,true),notes=txt(b.notes,6000),url=cleanUrl(b.url);
    const task_id=b.task_id?positiveInt(b.task_id,'task'):null;
    if(task_id){
      if(!await one(db,'SELECT id FROM tasks WHERE id=?',task_id))fail(404,'Task not found.');
      if(user.role!=='admin'&&!await one(db,'SELECT 1 AS ok FROM assignments WHERE task_id=? AND user_id=?',task_id,user.id))fail(403,'This assignment is not yours.');
    }
    const filename=txt(String(b.filename??'').replace(/\\/g,'/').split('/').pop(),180,true);
    const suffix=filename.slice(filename.lastIndexOf('.')).toLowerCase();
    if(!ALLOWED_SUFFIXES.has(suffix))fail(400,'Unsupported file type. Use PDF, Office documents, images, audio or video.');
    const size=Number(b.size);
    if(!Number.isSafeInteger(size)||size<0||size>MAX_UPLOAD)fail(413,'File exceeds 50 MB limit.');
    await run(db,"DELETE FROM submissions WHERE upload_state='uploading' AND created_at<?",new Date(Date.now()-86400000).toISOString());
    if(await one(db,"SELECT id FROM submissions WHERE upload_state='uploading' AND user_id=? LIMIT 1",user.id))fail(409,'An upload is already underway on your account. Finish or retry it before starting another.');
    const usage=await one(db,"SELECT COALESCE(SUM(size),0) AS total FROM submissions WHERE stored_name!=''");
    if(usage.total+size>MAX_DB_MEDIA)fail(413,'Team file storage is approaching the free D1 database limit. Submit a private Google Drive link, or ask Max to archive older files.');
    const mime=txt(b.mime||'application/octet-stream',120),stored_name=randomToken(16)+suffix;
    const added=await one(db,`INSERT INTO submissions(user_id,task_id,title,notes,url,filename,stored_name,mime,size,created_at,upload_state)
      VALUES(?,?,?,?,?,?,?,?,?,?,'uploading') RETURNING id`,user.id,task_id,title,notes,url,filename,stored_name,mime,size,now());
    return json({id:added.id,part_size:FILE_PART,total_parts:Math.ceil(size/FILE_PART)});
  }
  if((m=path.match(/^\/api\/submissions\/(\d+)\/chunk\/(\d+)$/))&&method==='PUT'){
    const sid=positiveInt(m[1]),part=Number(m[2]);
    const record=await one(db,'SELECT id,user_id,size,upload_state FROM submissions WHERE id=?',sid);
    if(!record)fail(404,'Submission not found.');
    if(record.user_id!==user.id||record.upload_state!=='uploading')fail(403,'Upload permission denied.');
    const total=Math.ceil(record.size/FILE_PART);
    if(!Number.isSafeInteger(part)||part<0||part>=total)fail(400,'Invalid file chunk.');
    const buffer=await request.arrayBuffer();
    const expected=Math.min(FILE_PART,record.size-part*FILE_PART);
    if(buffer.byteLength!==expected)fail(400,'Chunk has incorrect length.');
    await run(db,'INSERT OR REPLACE INTO submission_chunks(submission_id,part,data) VALUES(?,?,?)',sid,part,new Uint8Array(buffer));
    return json({ok:true,part});
  }
  if((m=path.match(/^\/api\/submissions\/(\d+)\/finish$/))&&method==='POST'){
    const sid=positiveInt(m[1]);
    const record=await one(db,'SELECT id,user_id,size,task_id,upload_state FROM submissions WHERE id=?',sid);
    if(!record)fail(404,'Submission not found.');
    if(record.user_id!==user.id||record.upload_state!=='uploading')fail(403,'Upload permission denied.');
    const count=await one(db,'SELECT COUNT(*) AS n,COALESCE(SUM(LENGTH(data)),0) AS bytes FROM submission_chunks WHERE submission_id=?',sid);
    if(count.n!==Math.ceil(record.size/FILE_PART)||count.bytes!==record.size)fail(400,'Upload incomplete. Please retry.');
    await run(db,"UPDATE submissions SET upload_state='ready' WHERE id=?",sid);
    if(record.task_id)await run(db,"UPDATE assignments SET status='submitted',updated_at=? WHERE task_id=? AND user_id=?",now(),record.task_id,user.id);
    return json({ok:true,id:sid});
  }
  if((m=path.match(/^\/api\/submissions\/(\d+)\/abort$/))&&method==='POST'){
    const sid=positiveInt(m[1]);
    await run(db,"DELETE FROM submissions WHERE id=? AND user_id=? AND upload_state='uploading'",sid,user.id);
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/submissions\/(\d+)\/chunk\/(\d+)$/))&&method==='GET'){
    const sid=positiveInt(m[1]),part=Number(m[2]);
    const record=await one(db,'SELECT user_id,size,upload_state FROM submissions WHERE id=?',sid);
    if(!record)fail(404,'Submission not found.');
    if(record.upload_state!=='ready')fail(404,'Submission not available yet.');
    if(user.role!=='admin'&&record.user_id!==user.id)fail(403,'Access denied.');
    if(!Number.isSafeInteger(part)||part<0||part>=Math.ceil(record.size/FILE_PART))fail(404,'File chunk not found.');
    const chunk=await one(db,'SELECT data FROM submission_chunks WHERE submission_id=? AND part=?',sid,part);
    if(!chunk)fail(404,'File chunk not found.');
    const bytes=Uint8Array.from(chunk.data);
    return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store','Content-Length':String(bytes.length)}});
  }
  if(method==='POST'&&path==='/api/submissions'){
    let form;try{form=await request.formData();}catch{fail(400,'Invalid upload form.');}
    const title=txt(form.get('title'),180,true),notes=txt(form.get('notes'),6000),url=cleanUrl(form.get('url'));
    const tidRaw=String(form.get('task_id')??'').trim();const task_id=tidRaw?positiveInt(tidRaw,'task'):null;
    const attachment=form.get('attachment');const file=attachment && typeof attachment==='object'&&typeof attachment.arrayBuffer==='function'&&attachment.name?attachment:null;
    if(!url&&!file)fail(400,'Attach a file or paste a link.');
    if(task_id){
      if(!await one(db,'SELECT id FROM tasks WHERE id=?',task_id))fail(404,'Task not found.');
      if(user.role!=='admin'&&!await one(db,'SELECT 1 AS ok FROM assignments WHERE task_id=? AND user_id=?',task_id,user.id))fail(403,'This assignment is not yours.');
    }
    let filename='',stored_name='',mime='',size=0;
    if(file){
      filename=txt(String(file.name).replace(/\\/g,'/').split('/').pop(),180,true);
      const dot=filename.lastIndexOf('.'),suffix=filename.slice(dot).toLowerCase();
      if(!ALLOWED_SUFFIXES.has(suffix))fail(400,'Unsupported file type. Use PDF, Office documents, images, audio or video.');
      size=file.size;
      if(size>MAX_UPLOAD)fail(413,'File exceeds 50 MB limit.');
      if(size>MAX_DIRECT_UPLOAD)fail(413,'Large files must use the website upload form.');
      if(size<0 || !Number.isInteger(size))fail(400,'Invalid file.');
      const usage=await one(db,"SELECT COALESCE(SUM(size),0) AS total FROM submissions WHERE stored_name!=''");
      if(usage.total+size>MAX_DB_MEDIA)fail(413,'Team file storage is approaching the free D1 database limit. Submit a private Google Drive link, or ask Max to archive older files.');
      stored_name=randomToken(16)+suffix;mime=txt(file.type||'application/octet-stream',120);
    }
    const added=await one(db,`INSERT INTO submissions(user_id,task_id,title,notes,url,filename,stored_name,mime,size,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`,user.id,task_id,title,notes,url,filename,stored_name,mime,size,now());
    try {
      if(file){
        for(let part=0,pos=0;pos<size;part++,pos+=FILE_PART){
          const bytes=new Uint8Array(await file.slice(pos,Math.min(size,pos+FILE_PART)).arrayBuffer());
          await run(db,'INSERT INTO submission_chunks(submission_id,part,data) VALUES(?,?,?)',added.id,part,bytes);
        }
      }
      if(task_id)await run(db,"UPDATE assignments SET status='submitted',updated_at=? WHERE task_id=? AND user_id=?",now(),task_id,user.id);
    }catch(err){
      // A partial upload must not be visible as a successful submission.
      try{await run(db,'DELETE FROM submission_chunks WHERE submission_id=?',added.id);await run(db,'DELETE FROM submissions WHERE id=?',added.id);}catch{}
      throw err;
    }
    return json({ok:true,id:added.id});
  }
  if((m=path.match(/^\/api\/submissions\/(\d+)\/download$/))&&method==='GET'){
    const sid=positiveInt(m[1]);const submission=await one(db,'SELECT * FROM submissions WHERE id=?',sid);
    if(!submission)fail(404,'Submission not found.');
    if(user.role!=='admin'&&submission.user_id!==user.id)fail(403,'Access denied.');
    if(!submission.stored_name||submission.upload_state!=='ready')fail(404,'No file attached.');
    if(submission.size>MAX_DIRECT_UPLOAD)fail(400,'For large files, use the Download button inside Forum HQ.');
    const parts=Math.ceil(submission.size/FILE_PART);let part=0;
    const stream=new ReadableStream({
      async pull(controller){
        if(part>=parts){controller.close();return;}
        try{
          const chunk=await one(db,'SELECT data FROM submission_chunks WHERE submission_id=? AND part=?',sid,part++);
          if(!chunk){controller.error(new Error('File is incomplete.'));return;}
          controller.enqueue(Uint8Array.from(chunk.data));
        }catch(e){controller.error(e);}
      }
    });
    const safe=encodeURIComponent(submission.filename);
    return new Response(stream,{headers:{
      'Content-Type':'application/octet-stream','Content-Length':String(submission.size),
      'Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${safe}`,
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'
    }});
  }
  if((m=path.match(/^\/api\/submissions\/(\d+)$/))&&method==='PATCH'){
    checkAdmin(user);const sid=positiveInt(m[1]),b=await bodyJson(request);
    const status=b.status||'reviewed';if(!['new','reviewed','revision_requested'].includes(status))fail(400,'Invalid review status.');
    const result=await run(db,'UPDATE submissions SET status=?,feedback=? WHERE id=?',status,txt(b.feedback,4000),sid);
    if(!result.meta?.changes)fail(404,'Submission not found.');return json({ok:true});
  }
  if(method==='POST'&&path==='/api/announcements'){
    checkAdmin(user);const b=await bodyJson(request);
    await run(db,'INSERT INTO announcements(title,body,pinned,created_by,created_at) VALUES(?,?,?,?,?)',txt(b.title,180,true),txt(b.body,8000,true),b.pinned?1:0,user.id,now());
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/announcements\/(\d+)$/))&&method==='DELETE'){
    checkAdmin(user);await run(db,'DELETE FROM announcements WHERE id=?',positiveInt(m[1]));return json({ok:true});
  }
  if(method==='POST'&&path==='/api/resources'){
    checkAdmin(user);const b=await bodyJson(request);
    await run(db,'INSERT INTO resources(title,category,description,url,body,created_by,created_at) VALUES(?,?,?,?,?,?,?)',txt(b.title,180,true),txt(b.category??'Guide',50,true),txt(b.description,500),cleanUrl(b.url),txt(b.body,12000),user.id,now());
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/resources\/(\d+)$/))&&method==='DELETE'){
    checkAdmin(user);await run(db,'DELETE FROM resources WHERE id=?',positiveInt(m[1]));return json({ok:true});
  }
  if(method==='POST'&&path==='/api/tournaments'){
    checkAdmin(user);const b=await bodyJson(request);const d=validDate(b.event_date);
    if(!d||d.includes('T'))fail(400,'Choose a tournament date.');
    await run(db,'INSERT INTO tournaments(title,event_date,event_time,location,details,link,created_at) VALUES(?,?,?,?,?,?,?)',txt(b.title,180,true),d,txt(b.event_time,40),txt(b.location,200),txt(b.details,5000),cleanUrl(b.link),now());
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/tournaments\/(\d+)$/))&&method==='DELETE'){
    checkAdmin(user);await run(db,'DELETE FROM tournaments WHERE id=?',positiveInt(m[1]));return json({ok:true});
  }
  if((m=path.match(/^\/api\/lessons\/([a-z0-9-]+)$/))&&method==='PUT'){
    const slug=m[1],b=await bodyJson(request);if(slug.length<3||slug.length>60)fail(400,'Invalid lesson.');
    const status=b.status||'learning';if(!LESSON_STATUSES.has(status))fail(400,'Invalid lesson status.');
    await run(db,`INSERT INTO lesson_progress(user_id,slug,status,notes,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,slug) DO UPDATE SET status=excluded.status,notes=excluded.notes,updated_at=excluded.updated_at`,user.id,slug,status,txt(b.notes,2000),now());
    return json({ok:true});
  }
  if(method==='POST'&&path==='/api/mistakes'){
    const b=await bodyJson(request),uid=user.role==='admin'&&b.user_id!==undefined?positiveInt(b.user_id,'member'):user.id;
    if(!await one(db,'SELECT id FROM users WHERE id=?',uid))fail(404,'Member not found.');
    await run(db,'INSERT INTO mistakes(user_id,category,title,context,created_at,updated_at) VALUES(?,?,?,?,?,?)',uid,txt(b.category??'Other',80,true),txt(b.title,200,true),txt(b.context,4000),now(),now());
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/mistakes\/(\d+)$/))&&method==='PATCH'){
    const mid=positiveInt(m[1]),b=await bodyJson(request);
    if(!MISTAKE_STATUSES.has(b.status))fail(400,'Invalid review status.');
    const item=await one(db,'SELECT user_id FROM mistakes WHERE id=?',mid);
    if(!item)fail(404,'Review item not found.');
    if(user.role!=='admin'&&item.user_id!==user.id)fail(403,'Access denied.');
    await run(db,'UPDATE mistakes SET status=?,updated_at=? WHERE id=?',b.status,now(),mid);
    return json({ok:true});
  }
  if(method==='POST'&&path==='/api/feedback'){
    checkAdmin(user);const b=await bodyJson(request),uid=positiveInt(b.user_id,'member'),score=Number(b.score??3);
    if(!Number.isInteger(score)||score<1||score>5)fail(400,'Score must be 1–5.');
    if(!await one(db,'SELECT id FROM users WHERE id=?',uid))fail(404,'Member not found.');
    await run(db,'INSERT INTO feedback(user_id,author_id,category,score,positive,focus,created_at) VALUES(?,?,?,?,?,?,?)',uid,user.id,txt(b.category??'General',80),score,txt(b.positive,2500),txt(b.focus,2500),now());
    return json({ok:true});
  }
  if(method==='POST'&&path==='/api/cases'){
    const b=await bodyJson(request),side=b.side||'Pro',status=b.status||'draft';
    if(!['Pro','Con','Both'].includes(side))fail(400,'Invalid side.');
    if(!CASE_STATUSES.has(status))fail(400,'Invalid status.');
    await run(db,'INSERT INTO cases(title,side,category,argument,status,source_url,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',txt(b.title,180,true),side,txt(b.category??'Contention',80),txt(b.argument,12000),status,cleanUrl(b.source_url),user.id,now());
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/cases\/(\d+)$/))&&method==='PATCH'){
    const cid=positiveInt(m[1]),b=await bodyJson(request);
    const argument=await one(db,'SELECT created_by FROM cases WHERE id=?',cid);
    if(!argument)fail(404,'Argument not found.');
    if(user.role!=='admin'&&argument.created_by!==user.id)fail(403,'Only the author or admin may edit.');
    const fields=[],args=[];
    for(const [key,len] of [['title',180],['category',80],['argument',12000]])if(key in b){fields.push(`${key}=?`);args.push(txt(b[key],len,key==='title'));}
    if('source_url' in b){fields.push('source_url=?');args.push(cleanUrl(b.source_url));}
    if('status' in b){if(!CASE_STATUSES.has(b.status))fail(400,'Invalid status.');fields.push('status=?');args.push(b.status);}
    if(fields.length)await run(db,`UPDATE cases SET ${fields.join(',')} WHERE id=?`,...args,cid);
    return json({ok:true});
  }
  if((m=path.match(/^\/api\/cases\/(\d+)$/))&&method==='DELETE'){
    const cid=positiveInt(m[1]),argument=await one(db,'SELECT created_by FROM cases WHERE id=?',cid);
    if(!argument)fail(404,'Argument not found.');
    if(user.role!=='admin'&&argument.created_by!==user.id)fail(403,'Only the author or admin may delete.');
    await run(db,'DELETE FROM cases WHERE id=?',cid);return json({ok:true});
  }
  fail(404,'Not found.');
}
export default {
  async fetch(request,env) {
    try {
      const url=new URL(request.url);
      // Defense in depth for mutations: the token alone is not the only boundary.
      if(!['GET','HEAD','OPTIONS'].includes(request.method)){
        const origin=request.headers.get('Origin');
        if(origin && origin!==url.origin)fail(403,'Cross-site requests are not allowed.');
      }
      let response;
      if(url.pathname==='/health'||url.pathname.startsWith('/api/')) {
        response=await apiRoute(request,env,url.pathname);
      }else if(request.method==='GET'||request.method==='HEAD') {
        // Static assets contain no member data. Sensitive information only comes from /api.
        // Pass the original canonical URL to the assets service.
        // Rewriting / to /index.html triggers Cloudflare's automatic
        // /index.html -> / redirect and causes an infinite redirect loop.
        response=await env.ASSETS.fetch(request);
        if(url.pathname==='/' || url.pathname==='/index.html'){
          const h=new Headers(response.headers);h.set('Cache-Control','no-store');
          response=new Response(response.body,{status:response.status,headers:h});
        }
      } else fail(405,'Method not allowed.');
      return responseSecurity(response,request);
    } catch(e) {
      if(e instanceof HttpError) return responseSecurity(json({detail:e.detail},e.status),request);
      console.error('Forum HQ request error:',String(e?.stack||e));
      return responseSecurity(json({detail:'The server could not complete your request. Please try again.'},500),request);
    }
  }
};

// Export tiny test helpers so cryptography can be verified without exposing a route.
export const internals={passwordHash,passwordMatches};
