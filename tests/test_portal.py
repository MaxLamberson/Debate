import importlib
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def portal(tmp_path, monkeypatch):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.delenv('INITIAL_ADMIN_PASSWORD', raising=False)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    if 'app' in sys.modules:
        del sys.modules['app']
    module = importlib.import_module('app')
    with module.db() as con:
        con.execute("UPDATE users SET password_hash=? WHERE username='max'", (module.hash_password('VeryStrongAdminPassword!'),))
    yield module, TestClient(module.app)


def signin(client, username='max', password='VeryStrongAdminPassword!'):
    r = client.post('/api/login', json={'username':username, 'password':password})
    assert r.status_code == 200, r.text
    r = client.get('/api/me')
    assert r.status_code == 200
    return {'X-CSRF-Token':r.json()['csrf']}


def test_initialization_login_and_csrf(portal):
    mod, client = portal
    assert client.get('/api/state').status_code == 401
    assert client.post('/api/login',json={'username':'max','password':'wrong'}).status_code == 401
    headers = signin(client)
    state = client.get('/api/state').json()
    assert len(state['members']) == 11
    assert {'Alaina','Aanya','Kai','Parker','Lukas','Shikha','Xia','Akari','Kaori','Max','Lucy'} == {m['name'] for m in state['members']}
    assert any(t['event_date'] == '2026-12-13' for t in state['tournaments'])
    assert client.post('/api/tasks',json={'title':'Not allowed'}).status_code == 403
    assert client.post('/api/tasks',headers=headers,json={'title':'Case prep','assignees':[1,2]}).status_code == 200
    assert client.get('/api/state').json()['assignments']


def test_member_accounts_isolation_and_review(portal):
    mod, admin_client = portal
    ah = signin(admin_client)
    state=admin_client.get('/api/state').json()
    aanya=next(m for m in state['members'] if m['name']=='Aanya')
    alaina=next(m for m in state['members'] if m['name']=='Alaina')
    ra=admin_client.post(f"/api/members/{aanya['id']}/reset-password",headers=ah).json()
    rb=admin_client.post(f"/api/members/{alaina['id']}/reset-password",headers=ah).json()
    assert ra['temporary_password'] != rb['temporary_password']
    member_client=TestClient(mod.app)
    mh=signin(member_client,'aanya',ra['temporary_password'])
    other_client=TestClient(mod.app)
    oh=signin(other_client,'alaina',rb['temporary_password'])
    assert member_client.get('/api/state').status_code==200
    assert member_client.post('/api/tasks',headers=mh,json={'title':'Hacked','assignees':[aanya['id']]}).status_code==403
    assert member_client.post('/api/announcements',headers=mh,json={'title':'Spam','body':'Hi'}).status_code==403
    assert member_client.put('/api/availability',headers=mh,json={'slots':[[0,10]]}).status_code==400
    assert member_client.put('/api/availability',headers=mh,json={'slots':[[0,16],[5,10],[6,19]]}).status_code==200
    upload=member_client.post('/api/submissions',headers=mh,data={'title':'Practice recording'},files={'attachment':('test.mp4',b'example video content','video/mp4')})
    assert upload.status_code == 200,upload.text
    sid=upload.json()['id']
    assert other_client.get(f'/api/submissions/{sid}/download').status_code==403
    assert member_client.get(f'/api/submissions/{sid}/download').status_code==200
    assert sid not in [s['id'] for s in other_client.get('/api/state').json()['submissions']]
    assert admin_client.patch(f'/api/submissions/{sid}',headers=ah,json={'status':'revision_requested','feedback':'Please slow down your weighing.'}).status_code==200
    assert member_client.get('/api/state').json()['submissions'][0]['feedback']=='Please slow down your weighing.'
    assert member_client.post('/api/mistakes',headers=mh,json={'title':'Need evidence','category':'Evidence comparison'}).status_code==200
    mistake=member_client.get('/api/state').json()['mistakes'][0]
    assert mistake['status']=='open'
    assert other_client.patch(f"/api/mistakes/{mistake['id']}",headers=oh,json={'status':'resolved'}).status_code==403
    assert admin_client.post('/api/feedback',headers=ah,json={'user_id':aanya['id'],'category':'Impact calculus','score':3,'focus':'Compare probability'}).status_code==200
    assert len(member_client.get('/api/state').json()['feedback'])==1
    assert len(other_client.get('/api/state').json()['feedback'])==0


def test_case_stays_unfinished_and_password_change(portal):
    mod, client=portal
    headers=signin(client)
    r=client.post('/api/cases',headers=headers,json={'title':'Water use impact','side':'Pro','category':'Contention','argument':'Possible warrant: verify whether this applies.','status':'needs_review'})
    assert r.status_code==200
    cid=client.get('/api/state').json()['cases'][0]['id']
    assert client.get('/api/state').json()['cases'][0]['status']=='needs_review'
    assert client.patch(f'/api/cases/{cid}',headers=headers,json={'status':'draft'}).status_code==200
    assert client.get('/api/state').json()['cases'][0]['status']=='draft'
    assert client.post('/api/password',headers=headers,json={'current':'VeryStrongAdminPassword!','password':'AnotherStrongPassword!'}).status_code==200
    assert client.get('/api/me').status_code == 200
    assert client.post(f'/api/members/10/reset-password',headers=headers).status_code==400
    assert client.post('/api/login',json={'username':'max','password':'AnotherStrongPassword!'}).status_code==200


def test_assignment_progress_is_per_user(portal):
    mod, client=portal
    h=signin(client)
    state=client.get('/api/state').json()
    aanya=next(m for m in state['members'] if m['name']=='Aanya')
    alaina=next(m for m in state['members'] if m['name']=='Alaina')
    t=client.post('/api/tasks',headers=h,json={'title':'Write a con case','assignees':[aanya['id'],alaina['id']],'due_at':'2026-12-01'})
    tid=t.json()['id']
    assert client.patch(f'/api/tasks/{tid}/status',headers=h,json={'status':'done','user_id':aanya['id']}).status_code==200
    statuses={a['user_id']:a['status'] for a in client.get('/api/state').json()['assignments']}
    assert statuses[aanya['id']]=='done'
    assert statuses[alaina['id']]=='todo'
