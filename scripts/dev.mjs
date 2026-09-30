// Local dev server for the site Worker:  npm run dev   ->  http://localhost:8787   (password: test)
// Creates worker/.dev.vars with harmless TEST values when it is missing (the file is git-ignored). The fake GitHub
// token means the job list shows an error and jobs cannot be dispatched - that is expected. What works locally with
// real data: the page, login, the Kan search / episode lists / link previews (they read data/kan-index.json from
// GitHub and Kan's own pages). YouTube search needs a real YT_API_KEY in worker/.dev.vars.
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vars = path.join(root, 'worker', '.dev.vars');
if (!existsSync(vars)) {
  writeFileSync(vars, 'APP_PASSWORD=test\nGH_TOKEN=fake-local-only\nYT_API_KEY=fake-local-only\n');
  console.log('created worker/.dev.vars with test values');
}
const port = process.env.PORT || '8787';
const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'wr.mjs'), 'site', 'dev', '--port', port], { stdio: 'inherit' });
process.exit(r.status ?? 0);
