// Reset a member's password:  npm run reset-password -- <username> <new-password>
import { getDb } from '../src/db.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run reset-password -- <username> <new-password>');
  process.exit(1);
}
const info = getDb().prepare('UPDATE users SET password = ? WHERE username = ?').run(password, username);
if (!info.changes) {
  console.error(`No member with username "${username}".`);
  process.exit(1);
}
console.log(`Password for ${username} reset.`);
