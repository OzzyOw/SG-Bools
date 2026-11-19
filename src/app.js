// Express app: routes for auth, feed, matches, bets, members, account.
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, getMeta, nowIso, setPassword } from './db.js';
import { hashPassword, verifyPassword, createLimiter, configErrors, registrationOpen, MIN_PASSWORD_LENGTH } from './auth.js';
import { isValidLine } from './settle.js';
import * as bets from './bets.js';
import * as fmt from './format.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MINUTE = 60 * 1000;
const SESSION_MAX_AGE = 30 * 24 * 60 * MINUTE; // logged out after 30 days without a visit

export function createApp() {
  const problems = configErrors();
  if (problems.length) throw new Error(problems.join('\n'));

  // Failed-attempt limits (in memory, reset on restart).
  const loginLimiter = createLimiter({ max: 10, windowMs: 15 * MINUTE }); // per IP
  const inviteLimiter = createLimiter({ max: 10, windowMs: 15 * MINUTE }); // per IP
  const passwordLimiter = createLimiter({ max: 5, windowMs: 15 * MINUTE }); // per member, on /account
  const tooMany = (ms) => `Too many attempts. Try again in ${Math.ceil(ms / MINUTE)} minute${ms > MINUTE ? 's' : ''}.`;

  const app = express();
  app.set('views', path.join(root, 'views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(root, 'public')));
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true, // each visit restarts the 30 days
      cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MAX_AGE },
    })
  );

  // CSRF: reject state-changing requests that a browser says came from another site.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const source = req.get('origin') ?? req.get('referer');
    if (source && !sameHost(source, req.get('host'))) {
      return res.status(403).type('text').send('Cross-site request blocked.');
    }
    next();
  });

  // Shared view locals.
  app.use((req, res, next) => {
    const db = getDb();
    let user = req.session.userId
      ? db.prepare('SELECT id, username, display_name, session_epoch FROM users WHERE id = ?').get(req.session.userId)
      : null;
    // Gone (deleted, reseeded) or password changed since this session signed in: treat as logged out.
    if (user && user.session_epoch !== req.session.epoch) user = null;
    if (req.session.userId && !user) {
      delete req.session.userId;
      delete req.session.epoch;
    }
    res.locals.user = user;
    res.locals.flash = req.session.flash ?? null;
    delete req.session.flash;
    res.locals.fmt = fmt;
    res.locals.b = bets;
    res.locals.path = req.path;
    res.locals.syncInfo = { ok: getMeta('last_sync_ok'), error: getMeta('last_sync_error') };
    next();
  });

  const flash = (req, type, text) => {
    req.session.flash = { type, text };
  };

  // Start a fresh session for the newly signed-in user (prevents session fixation).
  const signIn = (req, userId, done) => {
    const { session_epoch: epoch } = getDb().prepare('SELECT session_epoch FROM users WHERE id = ?').get(userId);
    req.session.regenerate((err) => {
      if (err) return done(err);
      req.session.userId = userId;
      req.session.epoch = epoch;
      done();
    });
  };

  const requireLogin = (req, res, next) => {
    if (!res.locals.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    next();
  };

  // ---------- Auth ----------
  app.get('/login', (req, res) => res.render('login', { error: null, username: '', next: req.query.next ?? '/' }));

  app.post('/login', (req, res, next) => {
    const username = String(req.body.username ?? '');
    const password = String(req.body.password ?? '');
    const wait = loginLimiter.blockedFor(req.ip);
    if (wait) return res.status(429).render('login', { error: tooMany(wait), username, next: req.body.next });
    const u = getDb().prepare('SELECT id, password FROM users WHERE username = ?').get(username.trim());
    if (!verifyPassword(password, u?.password ?? null)) {
      loginLimiter.fail(req.ip);
      return res.status(401).render('login', { error: 'Wrong username or password.', username, next: req.body.next });
    }
    signIn(req, u.id, (err) => (err ? next(err) : res.redirect(safeNext(req.body.next))));
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

  app.get('/register', (req, res) => res.render('register', { error: null, form: {}, open: registrationOpen() }));

  app.post('/register', (req, res, next) => {
    const form = {
      invite: String(req.body.invite ?? '').trim(),
      username: String(req.body.username ?? '').trim(),
      display_name: String(req.body.display_name ?? '').trim(),
      password: req.body.password ?? '',
    };
    const fail = (error, status = 400) => res.status(status).render('register', { error, form, open: true });
    if (!registrationOpen()) return res.status(403).render('register', { error: null, form: {}, open: false });
    const wait = inviteLimiter.blockedFor(req.ip);
    if (wait) return fail(tooMany(wait), 429);
    if (form.invite !== process.env.INVITE_CODE.trim()) {
      inviteLimiter.fail(req.ip);
      return fail('That invite code is not right.');
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(form.username)) return fail('Username: 3–20 letters, numbers or _.');
    if (form.display_name.length < 1 || form.display_name.length > 20) return fail('Display name: 1–20 characters.');
    if (typeof form.password !== 'string' || form.password.length < MIN_PASSWORD_LENGTH) {
      return fail(`Password: at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const db = getDb();
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(form.username)) return fail('That username is taken.');
    // Display names label every bet, so two members can't share one.
    if (db.prepare('SELECT 1 FROM users WHERE display_name = ? COLLATE NOCASE').get(form.display_name)) {
      return fail('That display name is taken — pick another.');
    }
    const info = db
      .prepare('INSERT INTO users (username, display_name, password, created_at) VALUES (?, ?, ?, ?)')
      .run(form.username, form.display_name, hashPassword(form.password), nowIso());
    signIn(req, Number(info.lastInsertRowid), (err) => {
      if (err) return next(err);
      flash(req, 'ok', `Welcome to SG Bools, ${form.display_name}!`);
      res.redirect('/');
    });
  });

  app.use(requireLogin);

  // ---------- Feed ----------
  app.get('/', (req, res) => {
    const tab = ['all', 'pending', 'settled'].includes(req.query.tab) ? req.query.tab : 'all';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const result = bets.feed(tab, page);
    res.render('feed', { tab, page, ...result, records: bets.allRecords() });
  });

  // ---------- Matches ----------
  app.get('/matches', (req, res) => {
    const db = getDb();
    const now = nowIso();
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const matches = db
      .prepare(
        `SELECT m.*,
           COUNT(b.id) AS bet_total,
           COUNT(CASE WHEN b.bet_type = '1X2' THEN 1 END) AS n_1x2,
           COUNT(CASE WHEN b.bet_type = 'AH' THEN 1 END) AS n_ah,
           COUNT(CASE WHEN b.bet_type = 'OU' THEN 1 END) AS n_ou,
           COUNT(CASE WHEN b.bet_type = 'CS' THEN 1 END) AS n_cs,
           COUNT(CASE WHEN b.bet_type = 'OTHER' THEN 1 END) AS n_other
         FROM matches m
         LEFT JOIN bets b ON b.match_id = m.id
         WHERE m.kickoff_utc > ? AND m.kickoff_utc <= ?
         GROUP BY m.id
         ORDER BY m.kickoff_utc, m.competition, m.home_team`
      )
      .all(now, until);
    // Group by Singapore-time day.
    const days = [];
    for (const m of matches) {
      const key = fmt.sgDayKey(m.kickoff_utc);
      if (!days.length || days.at(-1).key !== key) days.push({ key, label: fmt.sgDate(m.kickoff_utc), matches: [] });
      days.at(-1).matches.push(m);
    }
    res.render('matches', { days, count: matches.length });
  });

  const loadMatch = (id) => getDb().prepare('SELECT * FROM matches WHERE id = ?').get(id);

  const renderMatch = (req, res, match, extra = {}) => {
    const list = bets.betsForMatch(match.id);
    res.status(extra.status ?? 200).render('match', {
      match,
      open: bets.isMatchOpen(match),
      groups: bets.groupBets(list, match),
      betCount: list.length,
      records: bets.allRecords(),
      form: extra.form ?? { bet_type: '1X2' },
      errors: extra.errors ?? [],
      duplicates: extra.duplicates ?? null,
    });
  };

  app.get('/matches/:id', (req, res) => {
    const match = loadMatch(req.params.id);
    if (!match) return res.status(404).render('error', { message: 'Match not found.' });
    renderMatch(req, res, match);
  });

  app.post('/matches/:id/bets', (req, res) => {
    const match = loadMatch(req.params.id);
    if (!match) return res.status(404).render('error', { message: 'Match not found.' });
    if (!bets.isMatchOpen(match)) {
      flash(req, 'err', 'Betting closed at kickoff — this match has started.');
      return res.redirect(`/matches/${match.id}`);
    }
    const { errors, fields } = parseBetForm(req.body);
    if (errors.length) return renderMatch(req, res, match, { status: 400, form: req.body, errors });
    const dups = bets.duplicatesOf(fields, match.id);
    if (dups.length && req.body.confirm_duplicate !== 'yes') {
      return renderMatch(req, res, match, { form: req.body, duplicates: dups });
    }
    bets.createBet(res.locals.user.id, match.id, fields);
    flash(req, 'ok', 'Bet posted.');
    res.redirect(`/matches/${match.id}`);
  });

  // ---------- Bets (owner actions) ----------
  const loadOwnBet = (req, res) => {
    const bet = bets.getBet(req.params.id);
    if (!bet) {
      res.status(404).render('error', { message: 'Bet not found.' });
      return null;
    }
    if (bet.user_id !== res.locals.user.id) {
      res.status(403).render('error', { message: 'Only the person who posted this bet can change it.' });
      return null;
    }
    const match = loadMatch(bet.match_id);
    return { bet, match, open: bets.isMatchOpen(match) };
  };

  const betToForm = (bet) => ({
    bet_type: bet.bet_type,
    pick_1x2: bet.bet_type === '1X2' ? bet.pick : '',
    pick_ah: bet.bet_type === 'AH' ? bet.pick : '',
    line_ah: bet.bet_type === 'AH' ? String(bet.line) : '',
    pick_ou: bet.bet_type === 'OU' ? bet.pick : '',
    line_ou: bet.bet_type === 'OU' ? String(bet.line) : '',
    cs_home: bet.cs_home ?? '',
    cs_away: bet.cs_away ?? '',
    other_text: bet.other_text ?? '',
    odds: fmt.odds(bet.odds_100),
    stake: (bet.stake_cents / 100).toFixed(2),
    description: bet.description ?? '',
  });

  app.get('/bets/:id/edit', (req, res) => {
    const ctx = loadOwnBet(req, res);
    if (!ctx) return;
    res.render('edit', { ...ctx, form: betToForm(ctx.bet), errors: [] });
  });

  app.post('/bets/:id/edit', (req, res) => {
    const ctx = loadOwnBet(req, res);
    if (!ctx) return;
    const { bet, match, open } = ctx;
    if (!open) {
      // After kickoff only the description may change.
      const description = trimmed(req.body.description);
      if (description.length > 500) {
        return res.status(400).render('edit', { ...ctx, form: { ...betToForm(bet), description }, errors: ['Description: 500 characters max.'] });
      }
      bets.updateDescription(bet.id, description || null);
      flash(req, 'ok', 'Description updated.');
      return res.redirect(`/matches/${match.id}`);
    }
    const { errors, fields } = parseBetForm(req.body);
    if (errors.length) return res.status(400).render('edit', { ...ctx, form: req.body, errors });
    bets.updateBet(bet.id, fields);
    flash(req, 'ok', 'Bet updated.');
    res.redirect(`/matches/${match.id}`);
  });

  app.post('/bets/:id/delete', (req, res) => {
    const ctx = loadOwnBet(req, res);
    if (!ctx) return;
    if (!ctx.open) {
      flash(req, 'err', 'Bets are locked after kickoff and cannot be deleted.');
      return res.redirect(`/matches/${ctx.match.id}`);
    }
    bets.deleteBet(ctx.bet.id);
    flash(req, 'ok', 'Bet deleted.');
    res.redirect(`/matches/${ctx.match.id}`);
  });

  app.post('/bets/:id/settle', (req, res) => {
    const ctx = loadOwnBet(req, res);
    if (!ctx) return;
    const { bet, match } = ctx;
    const result = req.body.result;
    if (bet.bet_type !== 'OTHER' || bet.result !== 'PENDING' || match.status !== 'FINISHED' || !['WON', 'LOST', 'VOID'].includes(result)) {
      flash(req, 'err', 'Only pending "Other" bets on finished matches can be settled by hand.');
      return res.redirect(`/matches/${match.id}`);
    }
    bets.settleOtherBet(bet, result);
    flash(req, 'ok', `Marked as ${bets.RESULT_LABELS[result]}.`);
    res.redirect(`/matches/${match.id}`);
  });

  // ---------- Members ----------
  app.get('/members', (req, res) => {
    const users = getDb().prepare('SELECT id, display_name, username FROM users ORDER BY display_name').all();
    const records = bets.allRecords();
    users.sort((a, b) => records[b.id].netCents - records[a.id].netCents);
    res.render('members', { users, records });
  });

  app.get('/members/:id', (req, res) => {
    const member = getDb().prepare('SELECT id, display_name, username, created_at FROM users WHERE id = ?').get(req.params.id);
    if (!member) return res.status(404).render('error', { message: 'Member not found.' });
    const list = bets.betsForUser(member.id);
    res.render('member', { member, list, records: bets.allRecords() });
  });

  // ---------- Account ----------
  const renderAccount = (res, status = 200, errors = {}) =>
    res.status(status).render('account', { error: null, deleteError: null, ...errors });

  /** Check the member's current password (limited per member). Returns an error message or null. */
  const checkCurrentPassword = (res, password) => {
    const key = res.locals.user.id;
    const wait = passwordLimiter.blockedFor(key);
    if (wait) return tooMany(wait);
    const u = getDb().prepare('SELECT password FROM users WHERE id = ?').get(key);
    if (!verifyPassword(String(password ?? ''), u.password)) {
      passwordLimiter.fail(key);
      return 'Current password is wrong.';
    }
    return null;
  };

  app.get('/account', (req, res) => renderAccount(res));

  app.post('/account/password', (req, res, next) => {
    const newPassword = req.body.next;
    const error = checkCurrentPassword(res, req.body.current);
    if (error) return renderAccount(res, 400, { error });
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      return renderAccount(res, 400, { error: `New password: at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    const userId = res.locals.user.id;
    setPassword(userId, newPassword); // also signs out every other device
    signIn(req, userId, (err) => {
      if (err) return next(err);
      flash(req, 'ok', 'Password changed. Any other devices are now logged out.');
      res.redirect('/account');
    });
  });

  app.post('/account/delete', (req, res, next) => {
    const deleteError = checkCurrentPassword(res, req.body.current);
    if (deleteError) return renderAccount(res, 400, { deleteError });
    getDb().prepare('DELETE FROM users WHERE id = ?').run(res.locals.user.id); // bets go with it (ON DELETE CASCADE)
    req.session.regenerate((err) => {
      if (err) return next(err);
      flash(req, 'ok', 'Your account and all your bets have been deleted.');
      res.redirect('/login');
    });
  });

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { message: 'Something went wrong.' });
  });

  return app;
}

// ---------- Request helpers ----------

/** Only allow same-site paths: "/x" but not "//host", "/\host" or anything with a backslash. */
export function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}

function sameHost(url, host) {
  try {
    return new URL(url).host === host;
  } catch {
    return false; // e.g. Origin: null
  }
}

// ---------- Bet form parsing ----------
const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const trimmed = (v) => String(v ?? '').trim();

export function parseBetForm(body) {
  const errors = [];
  const f = {
    bet_type: body.bet_type,
    pick: null,
    line: null,
    cs_home: null,
    cs_away: null,
    other_text: null,
  };
  switch (body.bet_type) {
    case '1X2':
      if (!['HOME', 'DRAW', 'AWAY'].includes(body.pick_1x2)) errors.push('Pick Home, Draw or Away.');
      f.pick = body.pick_1x2;
      break;
    case 'AH': {
      if (!['HOME', 'AWAY'].includes(body.pick_ah)) errors.push('Pick the team for the handicap.');
      const raw = trimmed(body.line_ah);
      const line = Number(raw);
      if (raw === '' || !isValidLine(line) || Math.abs(line) > 5) errors.push('Handicap line: a multiple of 0.25 between −5 and +5.');
      f.pick = body.pick_ah;
      f.line = line;
      break;
    }
    case 'OU': {
      if (!['OVER', 'UNDER'].includes(body.pick_ou)) errors.push('Pick Over or Under.');
      const raw = trimmed(body.line_ou);
      const line = Number(raw);
      if (raw === '' || !isValidLine(line) || line <= 0 || line > 10) errors.push('Goal line: a multiple of 0.25 between 0.25 and 10.');
      f.pick = body.pick_ou;
      f.line = line;
      break;
    }
    case 'CS': {
      const hRaw = trimmed(body.cs_home);
      const aRaw = trimmed(body.cs_away);
      const h = Number(hRaw);
      const a = Number(aRaw);
      const ok = (raw) => /^\d$/.test(raw);
      if (!ok(hRaw) || !ok(aRaw)) errors.push('Correct score: each side 0–9.');
      f.cs_home = h;
      f.cs_away = a;
      break;
    }
    case 'OTHER': {
      const t = trimmed(body.other_text);
      if (t.length < 1 || t.length > 100) errors.push('Describe the "Other" bet in 1–100 characters.');
      f.other_text = t;
      break;
    }
    default:
      errors.push('Choose a bet type.');
  }

  const oddsRaw = trimmed(body.odds);
  if (!MONEY_RE.test(oddsRaw) || Number(oddsRaw) <= 1) errors.push('Odds must be above 1.00 (up to 2 decimals).');
  f.odds_100 = Math.round(Number(oddsRaw) * 100);

  const stakeRaw = trimmed(body.stake).replace(/^\$/, '');
  if (!MONEY_RE.test(stakeRaw) || Number(stakeRaw) <= 0) errors.push('Stake must be above $0 (up to 2 decimals).');
  f.stake_cents = Math.round(Number(stakeRaw) * 100);

  const desc = trimmed(body.description);
  if (desc.length > 500) errors.push('Description: 500 characters max.');
  f.description = desc || null;

  return { errors, fields: f };
}
