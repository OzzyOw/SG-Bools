// Add pending demo bets to the existing database without wiping anything.
//   npm run add-pending            -> 5 per member
//   npm run add-pending -- 3       -> 3 per member
import { tx } from '../src/db.js';
import { addPendingBets } from './demo-bets.js';

const perMember = Number(process.argv[2] ?? 5);
if (!Number.isInteger(perMember) || perMember < 1) {
  console.error('Usage: npm run add-pending -- <bets per member>');
  process.exit(1);
}
try {
  const n = tx(() => addPendingBets(perMember));
  console.log(`Added ${n} pending bets (${perMember} per member).`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
