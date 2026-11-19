// Reset a member's password:  npm run reset-password -- <username>
// The new password is typed at a hidden prompt (not on the command line, where it would land in
// shell history). Every device that member is logged in on is signed out.
import { getDb, setPassword } from '../src/db.js';
import { MIN_PASSWORD_LENGTH } from '../src/auth.js';
import { askHidden } from './prompt.js';

const [username, extra] = process.argv.slice(2);
if (!username) {
  console.error('Usage: npm run reset-password -- <username>');
  process.exit(1);
}
if (extra) {
  console.error('Leave the password off the command line (it would be saved in shell history); you will be asked for it.');
  process.exit(1);
}
const user = getDb().prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No member with username "${username}".`);
  process.exit(1);
}

const password = await askHidden(`New password for ${user.username}: `);
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
  process.exit(1);
}
if (process.stdin.isTTY && (await askHidden('Type it again: ')) !== password) {
  console.error('The two passwords did not match. Nothing was changed.');
  process.exit(1);
}
setPassword(user.id, password);
console.log(`Password for ${user.username} reset. They have been logged out everywhere.`);
