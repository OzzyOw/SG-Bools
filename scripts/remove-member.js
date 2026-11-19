// Remove a member and every bet they posted:  npm run remove-member -- <username>
// For someone who has left the group. Members can also do this themselves on their Account page.
import { getDb } from '../src/db.js';
import { ask } from './prompt.js';

const [username] = process.argv.slice(2);
if (!username) {
  console.error('Usage: npm run remove-member -- <username>');
  process.exit(1);
}
const db = getDb();
const user = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No member with username "${username}".`);
  process.exit(1);
}
const { n } = db.prepare('SELECT COUNT(*) AS n FROM bets WHERE user_id = ?').get(user.id);
const answer = await ask(
  `Permanently delete ${user.display_name} (@${user.username}) and their ${n} bet${n === 1 ? '' : 's'}? Type the username to confirm: `
);
if (answer.trim().toLowerCase() !== user.username.toLowerCase()) {
  console.log('Not confirmed. Nothing was changed.');
  process.exit(1);
}
db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // bets go with it (ON DELETE CASCADE)
console.log(`Removed ${user.display_name} and ${n} bet${n === 1 ? '' : 's'}. They are logged out everywhere.`);
