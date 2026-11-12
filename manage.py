"""Provision the first administrator without shipping a default password."""
import argparse
import getpass
from app import db, hash_password, ensure_password

p=argparse.ArgumentParser(description='Forum HQ administrator setup')
p.add_argument('command',choices=['init-admin'])
p.add_argument('--username',default='max')
args=p.parse_args()
if args.command=='init-admin':
    with db() as con:
        user=con.execute('SELECT id,name FROM users WHERE username=?',(args.username.lower(),)).fetchone()
        if not user:
            print('Username not found. Seeded names include max; run the server once to initialize.');raise SystemExit(1)
        first=getpass.getpass('New admin password (10+ characters): ')
        second=getpass.getpass('Confirm password: ')
        if first!=second:raise SystemExit('Passwords did not match.')
        try:ensure_password(first)
        except Exception:raise SystemExit('Password must be 10–128 characters.')
        con.execute("UPDATE users SET password_hash=?,role='admin',active=1 WHERE id=?",(hash_password(first),user['id']))
        con.execute('DELETE FROM sessions WHERE user_id=?',(user['id'],))
    print('Admin account ready. Sign in with username:',args.username.lower())
