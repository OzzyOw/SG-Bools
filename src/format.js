// View helpers: Singapore time, money, records.
const TZ = 'Asia/Singapore';

const dtFmt = new Intl.DateTimeFormat('en-SG', {
  timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-SG', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-SG', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });

export const sgDateTime = (iso) => dtFmt.format(new Date(iso));
export const sgDate = (iso) => dateFmt.format(new Date(iso));
export const sgTime = (iso) => timeFmt.format(new Date(iso));
export const sgDayKey = (iso) => dayKeyFmt.format(new Date(iso)); // YYYY-MM-DD in SGT

export function money(cents, { sign = false } = {}) {
  const abs = (Math.abs(cents) / 100).toFixed(2);
  if (!sign) return `$${abs}`;
  if (cents > 0) return `+$${abs}`;
  if (cents < 0) return `−$${abs}`;
  return '$0.00';
}

export const odds = (odds100) => (odds100 / 100).toFixed(2);

export function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function recordLine(rec) {
  if (!rec) return '';
  const parts = [`${rec.wins}W`, `${rec.losses}L`];
  if (rec.pending) parts.push(`${rec.pending} pending`);
  return parts.join(' · ');
}

export const moneyClass = (cents) => (cents > 0 ? 'pos' : cents < 0 ? 'neg' : 'zero');
