/** Provision/reset Max's password without placing plaintext in Git or a Cloudflare secret. */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const mode = process.argv.includes('--remote') ? '--remote' : '--local';
if (!process.stdin.isTTY) { console.error('Run this script in the interactive Codespaces terminal.');process.exit(1); }
function secretInput(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const input=process.stdin;
    let str='';
    readline.emitKeypressEvents(input);
    input.setRawMode(true);input.resume();
    const onKey=(ch,key={})=>{
      if(key.ctrl && key.name==='c'){process.stdout.write('\n');input.setRawMode(false);process.exit(130);}
      if(key.name==='return'||key.name==='enter'){
        input.off('keypress',onKey);input.setRawMode(false);input.pause();process.stdout.write('\n');resolve(str);return;
      }
      if(key.name==='backspace'){if(str.length){str=str.slice(0,-1);process.stdout.write('\b \b');}return;}
      if(ch&&ch.length===1&&!key.ctrl&&str.length<128){str+=ch;process.stdout.write('*');}
    };
    input.on('keypress',onKey);
  });
}
const first=await secretInput('New Max admin password (10–128 characters): ');
const confirm=await secretInput('Repeat password: ');
if(first!==confirm || first.length<10 || first.length>128){console.error('Passwords differ or do not meet length requirements.');process.exit(1);}
const salt=randomBytes(16),iterations=310000;
const hash=pbkdf2Sync(first,salt,iterations,32,'sha256');
const packed=`pbkdf2-sha256$${iterations}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
const sql=`UPDATE users SET password_hash='${packed}',active=1,role='admin' WHERE username='max'; DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='max');`;
console.log(`Setting Max's password in ${mode==='--remote'?'REMOTE Cloudflare D1':'LOCAL development D1'}...`);
const child=spawn(process.platform==='win32'?'npx.cmd':'npx',['wrangler','d1','execute','forum-hq-db',mode,'--command',sql,'--yes'],{stdio:'inherit',shell:false});
child.on('exit',code=>process.exit(code||0));
