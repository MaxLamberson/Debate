# Forum HQ: the five commands you need

After you unzip and put all new files at your GitHub repo root, open a Codespaces terminal there:

```bash
npm install
npx wrangler login
npx wrangler d1 list
```

Copy the actual `forum-hq-db` database ID from the output into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Then run:

```bash
npm run db:remote
npm run admin:remote
npm run deploy
```

`admin:remote` prompts you for your private Max password. After deployment, open the `.workers.dev` URL and sign in as **max**.

To connect your GoDaddy domain: Cloudflare → Workers & Pages → `forum-hq` → Settings → Domains & Routes → Add → Custom Domain. Enter the Cloudflare-active domain and confirm. No separate Render account or R2 bucket is required.

**Do not upgrade to Workers Paid** if your requirement is $0. The free tier has strict limits; for giant recordings, use a private Drive link. Read `README.md` before inviting members, particularly the backup and database limits sections.
