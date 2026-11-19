// Void every pending bet on a match the API never finalises (abandoned, dropped from the feed).
//   npm run void-match -- <match id>      (the id is the number in the match page URL: /matches/<id>)
import { getDb } from '../src/db.js';
import { isMatchOpen, voidPendingBets } from '../src/bets.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id < 1) {
  console.error('Usage: npm run void-match -- <match id>');
  process.exit(1);
}
const match = getDb().prepare('SELECT * FROM matches WHERE id = ?').get(id);
if (!match) {
  console.error(`No match with id ${id}.`);
  process.exit(1);
}
const name = `${match.home_team} v ${match.away_team} (${match.kickoff_utc}, ${match.status})`;
if (isMatchOpen(match)) {
  console.error(`${name} hasn't kicked off yet: members can still delete their own bets.`);
  process.exit(1);
}
const n = voidPendingBets(id);
console.log(`${name}: voided ${n} pending bet${n === 1 ? '' : 's'}.`);
