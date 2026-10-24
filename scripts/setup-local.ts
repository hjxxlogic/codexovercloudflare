import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.dev.vars'))
  throw new Error('.dev.vars already exists; refusing to overwrite');
const secret = randomBytes(32).toString('hex');
mkdirSync('.local', { recursive: true, mode: 0o700 });
writeFileSync('.dev.vars', `OWNER_SECRET=${secret}\n`, {
  mode: 0o600,
  flag: 'wx',
});
writeFileSync('.local/owner-secret', secret + '\n', {
  mode: 0o600,
  flag: 'wx',
});
console.log(
  'Local secret saved to .local/owner-secret (0600); Wrangler reads .dev.vars. Start npm run dev.',
);
