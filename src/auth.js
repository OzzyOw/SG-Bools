// Password hashing, attempt limiting and startup config checks. No dependencies beyond node:crypto.
import crypto from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8;

// ---------- Passwords ----------
// Stored as "scrypt$<salt hex>$<hash hex>" with a random 16-byte salt per password.
const PREFIX = 'scrypt$';
const KEY_LEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN);
  return `${PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

// Hash of a random password, compared against when the username doesn't exist so a wrong
// username takes as long as a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/** Constant-time check of a password against a stored hash. A missing user (stored = null) never matches. */
export function verifyPassword(password, stored) {
  const known = isHashed(stored);
  const [salt, hash] = (known ? stored : DUMMY_HASH).slice(PREFIX.length).split('$');
  const expected = Buffer.from(hash ?? '', 'hex');
  if (!salt || expected.length !== KEY_LEN) return false;
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), KEY_LEN);
  return crypto.timingSafeEqual(actual, expected) && known;
}

/** A random password that is easy to read out and type on a phone, e.g. "k7mq-x2pd-9fza". */
export function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i/l/o/0/1
  const group = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

// ---------- Attempt limiting ----------
/**
 * Fixed-window counter kept in memory: at most `max` failures per key per `windowMs`.
 * Used for login, invite-code and current-password checks.
 */
export function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  const live = (key) => {
    const e = hits.get(key);
    if (e && e.resetAt <= now()) {
      hits.delete(key);
      return null;
    }
    return e ?? null;
  };
  return {
    /** Milliseconds until `key` may try again, or 0 if it isn't blocked. */
    blockedFor(key) {
      const e = live(key);
      return e && e.count >= max ? e.resetAt - now() : 0;
    },
    fail(key) {
      if (hits.size > 10_000) for (const k of hits.keys()) live(k); // drop expired entries
      const e = live(key);
      if (e) e.count++;
      else hits.set(key, { count: 1, resetAt: now() + windowMs });
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// ---------- Config ----------
// Values shipped in .env.example. Anyone who has read the repo knows them.
export const EXAMPLE_INVITE_CODES = ['bools2026'];
export const EXAMPLE_SESSION_SECRETS = ['change-me', 'sg-bools-demo'];

/** Problems that should stop the server from starting. */
export function configErrors(env = process.env) {
  const errors = [];
  const secret = env.SESSION_SECRET ?? '';
  if (!secret || EXAMPLE_SESSION_SECRETS.includes(secret)) {
    errors.push(
      'SESSION_SECRET in .env is missing or still the example value. Set it to a long random string, e.g. the output of:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  } else if (secret.length < 16) {
    errors.push('SESSION_SECRET in .env is too short — use at least 16 random characters.');
  }
  return errors;
}

/** Registration is open only when INVITE_CODE is set to something other than the published example. */
export function registrationOpen(env = process.env) {
  const code = (env.INVITE_CODE ?? '').trim();
  return code.length > 0 && !EXAMPLE_INVITE_CODES.includes(code);
}

/** Where the server listens: this computer only, unless HOST opts in to the network. */
export function listenHost(env = process.env) {
  return (env.HOST ?? '').trim() || '127.0.0.1';
}

export function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}
