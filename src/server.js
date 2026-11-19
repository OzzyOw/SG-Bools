import os from 'node:os';
import { createApp } from './app.js';
import { getDb, getMeta } from './db.js';
import { startScheduler, hasApiKey } from './footballData.js';
import { configErrors, registrationOpen, listenHost, isLoopback } from './auth.js';

const problems = configErrors();
if (problems.length) {
  for (const p of problems) console.error(`Not starting: ${p}`);
  process.exit(1);
}

getDb();
const app = createApp();
const port = Number(process.env.PORT) || 3000;
// This computer only by default. Set HOST=0.0.0.0 in .env to let phones on the same Wi-Fi in.
const host = listenHost();

app.listen(port, host, () => {
  console.log(`SG Bools running:`);
  console.log(`  this computer:  http://localhost:${port}`);
  if (isLoopback(host)) {
    console.log('  (only this computer can connect — set HOST=0.0.0.0 in .env for phones on the same Wi-Fi)');
  } else {
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const n of nets ?? []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  same Wi-Fi:      http://${n.address}:${port}`);
      }
    }
    console.warn('  Anyone on this network can reach the login page. Traffic is plain HTTP, so only use a trusted home Wi-Fi.');
    if (getMeta('demo_logins') === '1') {
      console.warn('  WARNING: the database still has the published demo logins (npm run seed:demo).');
      console.warn('           Anyone on this network can sign in with them. Run `npm run seed` for random passwords.');
    }
  }
  if (!registrationOpen()) console.warn('  (registration is off until INVITE_CODE in .env is set to your own code)');
  if (!hasApiKey()) console.warn('  (no FOOTBALL_DATA_API_KEY in .env — match data will not refresh)');
});

startScheduler();
