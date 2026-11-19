import os from 'node:os';
import { createApp } from './app.js';
import { getDb } from './db.js';
import { startScheduler, hasApiKey } from './footballData.js';

getDb();
const app = createApp();
const port = Number(process.env.PORT) || 3000;

// Listen on all interfaces so phones on the same Wi-Fi can reach it.
app.listen(port, '0.0.0.0', () => {
  console.log(`SG Bools running:`);
  console.log(`  this computer:  http://localhost:${port}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  same Wi-Fi:      http://${n.address}:${port}`);
    }
  }
  if (!hasApiKey()) console.warn('  (no FOOTBALL_DATA_API_KEY in .env — match data will not refresh)');
});

startScheduler();
