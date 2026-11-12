import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker,{internals} from '../src/worker.js';
const sql = readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
function mockD1(){
  const sqlite=new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(sql);
  return {
    prepare(query){
      const prepared = (args=[]) => {
        const stmt=sqlite.prepare(query);
        const params=args.map(a=>a instanceof Uint8Array?Buffer.from(a):a);
        return {sql:query,
          async first(){const row=stmt.get(...params);return row?convert(row):null;},
          async all(){return {results:stmt.all(...params).map(convert)};},
          async run(){const r=stmt.run(...params);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
        };
      };
      return { bind(...args){return prepared(args);}, ...prepared() };
    },
    async batch(items){const out=[];for(const item of items)out.push(/^\s*SELECT/i.test(item.sql)?await item.all():await item.run());return out;},
    _sqlite:sqlite
  };
}
function convert(row){const out={};for(const [key,value] of Object.entries(row))out[key]=Buffer.isBuffer(value)?Array.from(value):value;return out;}
async function setup(){
  const DB=mockD1();const env={DB,ASSETS:{fetch:()=>new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}})}};
  DB._sqlite.prepare('UPDATE users SET password_hash=? WHERE username=?').run(await internals.passwordHash('VeryStrongAdminPassword!'),'max');
  const clients=()=>{
    let cookie='',csrf='';
    return {get cookie(){return cookie;},get csrf(){return csrf;},
      async request(path,method='GET',body=null,headers={}){
        const h={'Cookie':cookie,...headers};let b;
        if(body instanceof FormData)b=body;
        else if(body!==null){b=JSON.stringify(body);h['Content-Type']='application/json';}
        if(csrf&&method!=='GET')h['X-CSRF-Token']=csrf;
        const res=await worker.fetch(new Request('https://forum.example'+path,{method,headers:h,body:b}),env);
        const setCookie=res.headers.get('Set-Cookie');if(setCookie)cookie=setCookie.split(';')[0];
        return res;
      },
      async login(username,password){const login=await this.request('/api/login','POST',{username,password});assert.equal(login.status,200,await login.text());csrf=(await (await this.request('/api/me')).json()).csrf;},
      async state(){return await (await this.request('/api/state')).json();}
    };
  };
  return {DB,env,clients};
}
test('seed contains 11 debaters and novice tournament',async()=>{
  const {DB}=await setup();assert.equal(DB._sqlite.prepare('SELECT count(*) n FROM users').get().n,11);
  assert.equal(DB._sqlite.prepare('SELECT event_date FROM tournaments LIMIT 1').get().event_date,'2026-12-13');
});
test('login, authenticated state and CSRF enforcement',async()=>{
  const {clients,DB}=await setup(),admin=clients();
  assert.equal((await admin.request('/api/state')).status,401);
  assert.equal((await admin.request('/api/login','POST',{username:'max',password:'wrong'})).status,401);
  await admin.login('max','VeryStrongAdminPassword!');
  assert.equal((await admin.state()).members.length,11);
  const r=await worker.fetch(new Request('https://forum.example/api/announcements',{method:'POST',headers:{Cookie:admin.cookie,'Content-Type':'application/json'},body:JSON.stringify({title:'hi',body:'hi'})}),{DB});
  assert.equal(r.status,403);
});
test('member privacy, assignment status, media upload/download and feedback',async()=>{
  const {clients}=await setup(),admin=clients(),aanya=clients(),alaina=clients();
  await admin.login('max','VeryStrongAdminPassword!');
  const state=await admin.state();const id=n=>state.members.find(m=>m.name===n).id;
  const pw1=(await (await admin.request(`/api/members/${id('Aanya')}/reset-password`,'POST')).json()).temporary_password;
  const pw2=(await (await admin.request(`/api/members/${id('Alaina')}/reset-password`,'POST')).json()).temporary_password;
  await aanya.login('aanya',pw1);await alaina.login('alaina',pw2);
  assert.equal((await aanya.request('/api/tasks','POST',{title:'No',assignees:[id('Aanya')]})).status,403);
  assert.equal((await aanya.request('/api/announcements','POST',{title:'No',body:'No'})).status,403);
  assert.equal((await aanya.request('/api/availability','PUT',{slots:[[0,10]]})).status,400);
  assert.equal((await aanya.request('/api/availability','PUT',{slots:[[0,16],[5,10],[6,19]]})).status,200);
  const task=await (await admin.request('/api/tasks','POST',{title:'Con case',assignees:[id('Aanya'),id('Alaina')]})).json();
  assert.equal((await aanya.request(`/api/tasks/${task.id}/status`,'PATCH',{status:'done'})).status,200);
  let assignments=(await admin.state()).assignments;
  assert.equal(assignments.find(a=>a.user_id===id('Aanya')).status,'done');
  assert.equal(assignments.find(a=>a.user_id===id('Alaina')).status,'todo');
  const f=new FormData();f.set('title','Speech recording');f.set('notes','Need weighing');f.set('task_id',String(task.id));f.set('attachment',new File([new TextEncoder().encode('example-video-bytes')],'video.mp4',{type:'video/mp4'}));
  const uploaded=await aanya.request('/api/submissions','POST',f);
  assert.equal(uploaded.status,200,await uploaded.clone().text());const sid=(await uploaded.json()).id;
  assert.equal((await alaina.request(`/api/submissions/${sid}/download`)).status,403);
  const dl=await aanya.request(`/api/submissions/${sid}/download`);
  assert.equal(dl.status,200);assert.equal(await dl.text(),'example-video-bytes');
  assert.equal((await alaina.state()).submissions.length,0);
  assert.equal((await admin.request(`/api/submissions/${sid}`,'PATCH',{status:'revision_requested',feedback:'Improve weighing.'})).status,200);
  assert.equal((await aanya.state()).submissions[0].feedback,'Improve weighing.');
  assert.equal((await aanya.request('/api/mistakes','POST',{title:'Unclear warrant',category:'Evidence comparison'})).status,200);
  const item=(await aanya.state()).mistakes[0];
  assert.equal((await alaina.request(`/api/mistakes/${item.id}`,'PATCH',{status:'resolved'})).status,403);
  assert.equal((await admin.request('/api/feedback','POST',{user_id:id('Aanya'),category:'Clarity',score:4,focus:'Slow down'})).status,200);
  assert.equal((await aanya.state()).feedback.length,1);
  assert.equal((await alaina.state()).feedback.length,0);
});
test('lesson progress, case review and password changes',async()=>{
  const {clients}=await setup(),admin=clients();await admin.login('max','VeryStrongAdminPassword!');
  assert.equal((await admin.request('/api/lessons/impact-calculus','PUT',{status:'practicing',notes:'Not mastered'})).status,200);
  assert.equal((await admin.state()).progress[0].status,'practicing');
  assert.equal((await admin.request('/api/cases','POST',{title:'Possible water use argument',side:'Pro',status:'needs_review',argument:'Unverified evidence'})).status,200);
  const c=(await admin.state()).cases[0];assert.equal(c.status,'needs_review');
  assert.equal((await admin.request(`/api/cases/${c.id}`,'PATCH',{status:'draft'})).status,200);
  assert.equal((await admin.state()).cases[0].status,'draft');
  assert.equal((await admin.request('/api/password','POST',{current:'VeryStrongAdminPassword!',password:'AnotherStrongPassword!'})).status,200);
  const newSession=clients();await newSession.login('max','AnotherStrongPassword!');
});
test('chunked media: private, complete, and downloadable; pending uploads never appear',async()=>{
  const {clients,env}=await setup(),admin=clients(),member=clients(),stranger=clients();
  await admin.login('max','VeryStrongAdminPassword!');
  const state=await admin.state();const kai=state.members.find(m=>m.name==='Kai');
  const lucy=state.members.find(m=>m.name==='Lucy');
  const a=(await (await admin.request(`/api/members/${kai.id}/reset-password`,'POST')).json()).temporary_password;
  const b=(await (await admin.request(`/api/members/${lucy.id}/reset-password`,'POST')).json()).temporary_password;
  await member.login('kai',a);await stranger.login('lucy',b);
  const bytes=new Uint8Array(700_000);for(let i=0;i<bytes.length;i++)bytes[i]=i%223;
  const begin=await member.request('/api/submissions/start','POST',{title:'Practice',filename:'practice.mp4',size:bytes.length,mime:'video/mp4'});
  assert.equal(begin.status,200,await begin.clone().text());const started=await begin.json();
  assert.equal((await member.state()).submissions.length,0);
  assert.equal((await stranger.request(`/api/submissions/${started.id}/chunk/0`)).status,404);
  assert.equal((await stranger.request(`/api/submissions/${started.id}/chunk/0`,'PUT',null,{'Content-Type':'application/octet-stream'})).status,403);
  for(let i=0;i<started.total_parts;i++){
    const slice=bytes.slice(i*started.part_size,(i+1)*started.part_size);
    const r=await member.request(`/api/submissions/${started.id}/chunk/${i}`,'PUT',null,{'Content-Type':'application/octet-stream','X-CSRF-Token':member.csrf});
    // An empty raw request must be rejected without mutating the database.
    assert.equal(r.status,400);
    const raw=await worker.fetch(new Request(`https://forum.example/api/submissions/${started.id}/chunk/${i}`,{method:'PUT',headers:{Cookie:member.cookie,'X-CSRF-Token':member.csrf,'Content-Type':'application/octet-stream'},body:slice}),env);
    assert.equal(raw.status,200,await raw.text());
  }
  const finished=await member.request(`/api/submissions/${started.id}/finish`,'POST');
  assert.equal(finished.status,200,await finished.text());
  assert.equal((await member.state()).submissions.length,1);
  assert.equal((await stranger.state()).submissions.length,0);
  const parts=[];
  for(let i=0;i<started.total_parts;i++){
    assert.equal((await stranger.request(`/api/submissions/${started.id}/chunk/${i}`)).status,403);
    parts.push(new Uint8Array(await (await member.request(`/api/submissions/${started.id}/chunk/${i}`)).arrayBuffer()));
  }
  const actual=Buffer.concat(parts.map(p=>Buffer.from(p)));
  assert.deepEqual(actual,Buffer.from(bytes));
});

test('PBKDF2 hash stays within Cloudflare Workers 100k ceiling',async()=>{
  const h=await internals.passwordHash('ValidExamplePassword123!');
  assert.match(h,/^pbkdf2-sha256\$100000\$/);
  assert.equal(await internals.passwordMatches('ValidExamplePassword123!',h),true);
  assert.equal(await internals.passwordMatches('NotThePassword123!',h),false);
});
