// Run this project's own wrangler inside one of the two Worker folders.
//   node scripts/wr.mjs site deploy            (or: npm run deploy:site)
//   node scripts/wr.mjs relay deploy           (or: npm run deploy:relay)
//   node scripts/wr.mjs site secret put GH_TOKEN
//   node scripts/wr.mjs site secret list
//   node scripts/wr.mjs relay deploy --dry-run
// "site" = worker/ (the password-protected page + API), "relay" = relay/ (the Tel Aviv fetch relay for Kan).
// wrangler runs with that folder as its working directory, so its .dev.vars / .wrangler state stays next to the
// Worker it belongs to, and it is the wrangler installed in THIS project's node_modules (nothing borrowed from
// another project).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = { site: 'worker', relay: 'relay' };
const [target, ...args] = process.argv.slice(2);
if (!dirs[target] || !args.length) {
  console.error('usage: node scripts/wr.mjs <site|relay> <wrangler arguments>   e.g.  site deploy');
  process.exit(2);
}
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
if (!existsSync(wrangler)) {
  console.error('wrangler is not installed here - run `npm install` in ' + root);
  process.exit(2);
}
const r = spawnSync(process.execPath, [wrangler, ...args], { cwd: path.join(root, dirs[target]), stdio: 'inherit' });
process.exit(r.status ?? 1);
