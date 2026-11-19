// Passwords, sessions, attempt limits, registration, account deletion and config checks (issue #2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef';
process.env.INVITE_CODE = 'family-code';

const auth = await import('../src/auth.js');
const { getDb, nowIso, setMeta, migrate } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

// ---------- unit ----------

test('passwords are hashed with a per-user salt and verified', () => {
  const a = auth.hashPassword('correct horse');
  const b = auth.hashPassword('correct horse');
  assert.match(a, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(a, b, 'same password, different salt');
  assert.ok(auth.verifyPassword('correct horse', a));
  assert.ok(!auth.verifyPassword('correct horsE', a));
  assert.ok(!auth.verifyPassword('', a));
  assert.ok(!auth.verifyPassword('anything', null), 'missing user never matches');
  assert.ok(!auth.verifyPassword('plain', 'plain'), 'unhashed values never match');
  assert.ok(!auth.verifyPassword('x', 'scrypt$zz$00'), 'malformed hash does not throw');
});

test('plain-text passwords from older databases are hashed on startup', () => {
  const db = getDb();
  const { lastInsertRowid: id } = db
    .prepare("INSERT INTO users (username, display_name, password, created_at) VALUES ('legacy', 'Legacy', 'mum123', ?)")
    .run(nowIso());
  migrate(db);
  const { password } = db.prepare('SELECT password FROM users WHERE id = ?').get(id);
  assert.ok(auth.isHashed(password));
  assert.ok(auth.verifyPassword('mum123', password), 'old password still works');
  migrate(db);
  assert.equal(db.prepare('SELECT password FROM users WHERE id = ?').get(id).password, password, 'not hashed twice');
});

test('random seed passwords are long and differ', () => {
  const p = auth.randomPassword();
  assert.match(p, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.notEqual(p, auth.randomPassword());
});

test('limiter blocks after max failures until the window passes', () => {
  let t = 0;
  const l = auth.createLimiter({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) {
    assert.equal(l.blockedFor('ip'), 0);
    l.fail('ip');
  }
  assert.equal(l.blockedFor('ip'), 1000);
  assert.equal(l.blockedFor('other'), 0, 'keys are separate');
  t = 1000;
  assert.equal(l.blockedFor('ip'), 0);
});

test('config: example session secrets and invite codes are refused', () => {
  assert.equal(auth.configErrors({}).length, 1);
  assert.equal(auth.configErrors({ SESSION_SECRET: 'change-me' }).length, 1);
  assert.equal(auth.configErrors({ SESSION_SECRET: 'short' }).length, 1);
  assert.deepEqual(auth.configErrors({ SESSION_SECRET: 'a'.repeat(32) }), []);
  assert.ok(!auth.registrationOpen({}));
  assert.ok(!auth.registrationOpen({ INVITE_CODE: 'bools2026' }));
  assert.ok(!auth.registrationOpen({ INVITE_CODE: '  ' }));
  assert.ok(auth.registrationOpen({ INVITE_CODE: 'our-own-code' }));
});

test('server binds to this computer unless HOST opts in', () => {
  assert.equal(auth.listenHost({}), '127.0.0.1');
  assert.equal(auth.listenHost({ HOST: '0.0.0.0' }), '0.0.0.0');
  assert.ok(auth.isLoopback('127.0.0.1'));
  assert.ok(!auth.isLoopback('0.0.0.0'));
});

test('createApp refuses to start with the example session secret', () => {
  const saved = process.env.SESSION_SECRET;
  try {
    process.env.SESSION_SECRET = 'change-me';
    assert.throws(() => createApp(), /SESSION_SECRET/);
    delete process.env.SESSION_SECRET;
    assert.throws(() => createApp(), /SESSION_SECRET/);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

// ---------- HTTP ----------

let server;
let base;
before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A cookie-keeping browser stand-in. */
function client() {
  let cookie = '';
  return {
    async req(method, path, form) {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, location: res.headers.get('location'), text: await res.text(), setCookie: set };
    },
    get(path) {
      return this.req('GET', path);
    },
    post(path, form) {
      return this.req('POST', path, form);
    },
  };
}

let n = 0;
function addUser(password = 'longenough1') {
  const username = `user${++n}`;
  const info = getDb()
    .prepare('INSERT INTO users (username, display_name, password, created_at) VALUES (?, ?, ?, ?)')
    .run(username, `User ${n}`, auth.hashPassword(password), nowIso());
  return { id: Number(info.lastInsertRowid), username, password };
}

async function loggedIn(u) {
  const c = client();
  const r = await c.post('/login', { username: u.username, password: u.password });
  assert.equal(r.status, 302, 'login succeeds');
  return c;
}

test('login checks the hash; session cookie expires and rolls', async () => {
  const u = addUser();
  assert.equal((await client().post('/login', { username: u.username, password: 'wrong-password' })).status, 401);
  const c = client();
  const r = await c.post('/login', { username: u.username, password: u.password });
  assert.equal(r.status, 302);
  assert.match(r.setCookie, /Expires=/i);
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /SameSite=Lax/i);
  assert.equal((await c.get('/account')).status, 200);
});

test('changing the password logs out other sessions but keeps this one', async () => {
  const u = addUser();
  const phone = await loggedIn(u);
  const laptop = await loggedIn(u);
  const r = await laptop.post('/account/password', { current: u.password, next: 'brand-new-pass' });
  assert.equal(r.status, 302);
  assert.equal((await laptop.get('/account')).status, 200, 'the session that changed it stays in');
  const p = await phone.get('/account');
  assert.equal(p.status, 302, 'other session is logged out');
  assert.match(p.location, /^\/login/);
  assert.equal((await client().post('/login', { username: u.username, password: u.password })).status, 401);
  await loggedIn({ ...u, password: 'brand-new-pass' });
});

test('new passwords need 8 characters', async () => {
  const u = addUser();
  const c = await loggedIn(u);
  const r = await c.post('/account/password', { current: u.password, next: 'short12' });
  assert.equal(r.status, 400);
  assert.match(r.text, /at least 8 characters/);
});

test('wrong current password on the account page is limited per member', async () => {
  const u = addUser();
  const c = await loggedIn(u);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/account/password', { current: 'nope', next: 'whatever-123' })).status, 400);
  const r = await c.post('/account/password', { current: u.password, next: 'whatever-123' });
  assert.match(r.text, /Too many attempts/);
});

test('register: invite code required, 8-char passwords, unique display names, stored hashed', async () => {
  const c = client();
  const form = { invite: 'family-code', username: 'newbie', display_name: 'Newbie', password: 'short' };
  assert.match((await c.post('/register', form)).text, /at least 8 characters/);
  const taken = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(addUser().id).display_name;
  const clash = await c.post('/register', { ...form, password: 'long-enough', display_name: taken.toUpperCase() });
  assert.match(clash.text, /display name is taken/);
  const ok = await c.post('/register', { ...form, password: 'long-enough' });
  assert.equal(ok.status, 302);
  const row = getDb().prepare("SELECT password FROM users WHERE username = 'newbie'").get();
  assert.ok(auth.isHashed(row.password));
  assert.ok(auth.verifyPassword('long-enough', row.password));
});

test('register is off while INVITE_CODE is the published example', async () => {
  const saved = process.env.INVITE_CODE;
  try {
    process.env.INVITE_CODE = 'bools2026';
    const c = client();
    assert.match((await c.get('/register')).text, /Registration is turned off/);
    const r = await c.post('/register', { invite: 'bools2026', username: 'sneaky', display_name: 'Mum2', password: 'long-enough' });
    assert.equal(r.status, 403);
    assert.equal(getDb().prepare("SELECT 1 FROM users WHERE username = 'sneaky'").get(), undefined);
  } finally {
    process.env.INVITE_CODE = saved;
  }
});

test('deleting my account removes me and my bets and logs me out', async () => {
  const u = addUser();
  const db = getDb();
  db.prepare(
    "INSERT INTO matches (id, competition, competition_name, home_team, away_team, kickoff_utc, status, updated_at) VALUES (424242, 'PL', 'Premier League', 'A', 'B', ?, 'FINISHED', ?)"
  ).run(nowIso(), nowIso());
  db.prepare(
    "INSERT INTO bets (user_id, match_id, bet_type, other_text, odds_100, stake_cents, result, profit_cents, created_at, updated_at) VALUES (?, 424242, 'OTHER', 'x', 200, 1000, 'WON', 1000, ?, ?)"
  ).run(u.id, nowIso(), nowIso());
  const c = await loggedIn(u);
  assert.equal((await c.post('/account/delete', { current: 'wrong-password' })).status, 400);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id), 'wrong password deletes nothing');
  const r = await c.post('/account/delete', { current: u.password });
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bets WHERE user_id = ?').get(u.id).n, 0);
  assert.equal((await c.get('/account')).status, 302, 'logged out');
});

test('sync error detail is only shown to logged-in members', async () => {
  setMeta('last_sync_error', 'football-data.org answered 403 for PL');
  try {
    assert.doesNotMatch((await client().get('/login')).text, /answered 403/);
    const c = await loggedIn(addUser());
    assert.match((await c.get('/account')).text, /answered 403/);
  } finally {
    setMeta('last_sync_error', null);
  }
});

test('login is limited to 10 failures per IP', async () => {
  // Own app instance, so failures from earlier tests don't count.
  const own = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => own.once('listening', r));
  const url = `http://127.0.0.1:${own.address().port}/login`;
  const login = (password) =>
    fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: u.username, password }).toString(),
    });
  const u = addUser();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await login('guess' + i)).status, 401);
    const r = await login(u.password);
    assert.equal(r.status, 429, 'even the right password is refused while blocked');
    assert.match(await r.text(), /Too many attempts/);
  } finally {
    own.close();
  }
});
