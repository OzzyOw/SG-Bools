// Record a ~1 minute guided demo video of SG Bools.
//   1. npm start            (app must be running)
//   2. npm run demo:record  -> demo/sg-bools-demo.webm
// Uses the installed Microsoft Edge via Playwright. Logs in as "Me", posts a bet that duplicates
// someone else's, edits it, then deletes it again, so the database ends up as it started.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db.js';

const BASE = process.env.DEMO_URL || 'http://localhost:3000';
const W = 1280;
const H = 720;
const OUT_DIR = 'demo';
const OUT = path.join(OUT_DIR, 'sg-bools-demo.webm');

// ---------- pick a match whose bet "Me" can duplicate on camera ----------
const db = getDb();
const me = db.prepare("SELECT id FROM users WHERE username = 'me'").get();
if (!me) throw new Error('Demo user "me" not found — run npm run seed first.');
const target = db
  .prepare(
    `SELECT b.*, u.display_name, m.home_team, m.away_team
     FROM bets b JOIN users u ON u.id = b.user_id JOIN matches m ON m.id = b.match_id
     WHERE b.result = 'PENDING' AND b.user_id <> ? AND b.bet_type IN ('OU', '1X2')
       AND m.status IN ('SCHEDULED','TIMED') AND m.kickoff_utc > ?
       AND NOT EXISTS (SELECT 1 FROM bets x WHERE x.match_id = b.match_id AND x.user_id = ?)
     ORDER BY (b.bet_type = 'OU') DESC, (SELECT COUNT(*) FROM bets c WHERE c.match_id = b.match_id) DESC
     LIMIT 1`
  )
  .get(me.id, new Date(Date.now() + 60 * 60 * 1000).toISOString(), me.id);
if (!target) throw new Error('No open match with a bet to duplicate — run npm run add-pending first.');
const startBetIds = new Set(db.prepare('SELECT id FROM bets WHERE user_id = ?').all(me.id).map((r) => r.id));

// ---------- overlay helpers injected into every page ----------
const OVERLAY = () => {
  const css = `
    #demo-cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
      background:rgba(246,195,67,.55);border:2px solid #fff;box-shadow:0 0 0 2px rgba(10,58,130,.7);pointer-events:none;
      transition:transform .12s;left:-50px;top:-50px}
    #demo-cursor.down{transform:scale(.7)}
    .demo-ripple{position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;
      border:3px solid #f6c343;pointer-events:none;animation:demo-rip .6s ease-out forwards}
    @keyframes demo-rip{to{transform:scale(4);opacity:0}}
    #demo-caption{position:fixed;z-index:2147483645;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);opacity:0;
      width:min(900px,88vw);background:rgba(7,25,58,.94);color:#fff;border-left:6px solid #d6202f;border-radius:10px;
      padding:14px 20px 15px;font:500 19px/1.4 system-ui,'Segoe UI',sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);
      transition:opacity .35s, transform .35s;pointer-events:none}
    #demo-caption.on{opacity:1;transform:translateX(-50%) translateY(0)}
    #demo-caption .step{display:block;font:800 12px/1 system-ui,sans-serif;letter-spacing:1.5px;text-transform:uppercase;
      color:#f6c343;margin-bottom:6px}
    #demo-card{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center;
      background:radial-gradient(circle at 30% 20%,#164ea8,#072a5e 60%,#041a3d);color:#fff;text-align:center;
      font-family:system-ui,'Segoe UI',sans-serif;opacity:0;transition:opacity .5s;pointer-events:none}
    #demo-card.on{opacity:1}
    #demo-card .logo{font:italic 900 76px/1 system-ui,sans-serif;letter-spacing:-2px}
    #demo-card .logo span{color:#f6c343}
    #demo-card .bar{width:120px;height:6px;background:#d6202f;border-radius:3px;margin:22px 0}
    #demo-card .t{font-size:30px;font-weight:700;max-width:900px}
    #demo-card .s{font-size:19px;color:#c9d6ee;margin-top:14px;max-width:820px;line-height:1.5}
    .demo-carding #demo-cursor{opacity:0}
    .demo-hl{outline:3px solid #f6c343 !important;outline-offset:3px;border-radius:6px;transition:outline-color .3s}`;
  const add = () => {
    if (document.getElementById('demo-cursor')) return;
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    document.body.appendChild(c);
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    document.body.appendChild(cap);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      c.classList.add('down');
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
};

// ---------- recording ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const tmpDir = path.join(OUT_DIR, '.tmp');
fs.rmSync(tmpDir, { recursive: true, force: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: tmpDir, size: { width: W, height: H } },
});
await context.addInitScript(OVERLAY);
const page = await context.newPage();
const t0 = Date.now(); // the video starts when the page is created
const clicks = []; // seconds into the video, for the click sounds
page.on('dialog', (d) => d.accept());

const wait = (ms) => page.waitForTimeout(ms);
let mouse = { x: W / 2, y: H / 2 };

async function syncCursor() {
  await page.evaluate(({ x, y }) => {
    const c = document.getElementById('demo-cursor');
    if (c) { c.style.left = x + 'px'; c.style.top = y + 'px'; }
  }, mouse);
}
async function goto(url) {
  await page.goto(BASE + url);
  await syncCursor();
}
async function moveTo(locator, steps = 22) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps });
  mouse = { x, y };
}
async function click(locator, pause = 250) {
  await moveTo(locator);
  await wait(pause);
  clicks.push((Date.now() - t0) / 1000);
  await page.mouse.down();
  await page.mouse.up();
  // Navigation-triggering clicks: let the next page settle.
  await page.waitForLoadState('domcontentloaded');
  await syncCursor().catch(() => {});
}
async function type(locator, text) {
  await click(locator, 150);
  await locator.pressSequentially(text, { delay: 55 });
}
async function caption(step, text) {
  await page.evaluate(({ step, text }) => {
    const el = document.getElementById('demo-caption');
    el.classList.remove('on');
    el.innerHTML = (step ? `<span class="step">${step}</span>` : '') + text;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  }, { step, text });
}
async function highlight(locator, ms = 1600) {
  await locator.evaluate((el) => el.classList.add('demo-hl'));
  await wait(ms);
  await locator.evaluate((el) => el.classList.remove('demo-hl')).catch(() => {});
}
async function card(title, sub, ms) {
  await page.evaluate(({ title, sub }) => {
    let el = document.getElementById('demo-card');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-card';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="logo">SG <span>Bools</span></div><div class="bar"></div><div class="t">${title}</div><div class="s">${sub}</div>`;
    document.body.classList.add('demo-carding');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  }, { title, sub });
  await wait(ms);
}
async function hideCard() {
  await page.evaluate(() => {
    document.getElementById('demo-card')?.classList.remove('on');
    document.body.classList.remove('demo-carding');
  });
  await wait(500);
}
async function smoothScroll(dy, ms) {
  await page.evaluate(({ dy, ms }) => new Promise((res) => {
    const start = scrollY;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      scrollTo(0, start + dy * (p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2));
      p < 1 ? requestAnimationFrame(step) : res();
    };
    requestAnimationFrame(step);
  }), { dy, ms });
}

const STEPS = 7;
const s = (n, label) => `Step ${n} of ${STEPS} · ${label}`;

// 0. Intro
await goto('/login');
await card('Share your football bets with family and friends',
  'Post the bets you bought, see what everyone else is on, and find out whose tips actually win.', 5000);
await hideCard();

// 1. Login
await caption(s(1, 'Sign in'), 'Every member has their own account. New members join with the family invite code.');
await type(page.locator('#username'), 'me');
await type(page.locator('#password'), 'me123');
await click(page.getByRole('button', { name: 'Log in' }));
await wait(400);

// 2. Feed + record line
await caption(s(2, 'The feed'), "Everyone's latest bets in one place: the match, the pick, the odds, the stake, and why they bought it.");
await wait(3200);
const firstRecord = page.locator('.slip .rec').first();
await moveTo(firstRecord);
await caption(s(2, 'The feed'), "Above every bet is the poster's running record: wins, losses, pending bets and net money.");
await highlight(firstRecord, 2600);
await smoothScroll(420, 1800);
await wait(600);

// 3. Matches board
await click(page.locator('.nav a', { hasText: 'Matches' }));
await caption(s(3, 'Matches'), 'Real Premier League and Champions League fixtures load automatically. Columns count the bets on each match.');
await wait(1800);
const row = page.locator(`tr:has(a[href="/matches/${target.match_id}"])`);
await moveTo(row);
await highlight(row, 1600);
await click(page.locator(`a[href="/matches/${target.match_id}"]`).first());

// 4. Post a bet (that someone already bought)
await caption(s(4, 'Post a bet'), 'Pick the bet type and selection, then enter the odds and stake from your ticket.');
await wait(800);
const typeSel = page.locator('#bet_type');
await moveTo(typeSel);
await typeSel.selectOption(target.bet_type);
await wait(500);
if (target.bet_type === 'OU') {
  await click(page.locator(`input[name="pick_ou"][value="${target.pick}"]`).locator('..'));
  await type(page.locator('input[name="line_ou"]'), String(target.line));
} else {
  await click(page.locator(`input[name="pick_1x2"][value="${target.pick}"]`).locator('..'));
}
await type(page.locator('#odds'), (target.odds_100 / 100).toFixed(2));
await type(page.locator('#stake'), '20');
await type(page.locator('#description'), `Following ${target.display_name} on this one`);
await click(page.getByRole('button', { name: 'Post bet' }));

// 5. Duplicate notice + grouping
await caption(s(5, 'No double-ups'), `${target.display_name} already bought this exact bet, so SG Bools warns you before you post it again.`);
await highlight(page.locator('.flash-warn'), 3000);
await click(page.getByRole('button', { name: /post it anyway/i }));
const group = page.locator('.group', { has: page.locator('.people', { hasText: 'Me' }) }).first();
await group.scrollIntoViewIfNeeded();
await caption(s(5, 'No double-ups'), 'Identical bets are grouped, so everyone can see who is on the same pick.');
await highlight(group.locator('.group-head'), 2800);

// 6. Edit until kickoff, then locked
const mySlip = group.locator('.slip', { has: page.locator('.who', { hasText: 'Me' }) }).last();
await caption(s(6, 'Edit or delete'), 'You can change or delete your own bet any time before kickoff. After kickoff it locks.');
await click(mySlip.getByRole('link', { name: 'Edit' }));
await page.locator('#stake').fill('');
await type(page.locator('#stake'), '30');
await click(page.getByRole('button', { name: 'Save changes' }));
await wait(700);
const mySlip2 = page.locator('.group', { has: page.locator('.people', { hasText: 'Me' }) }).first()
  .locator('.slip', { has: page.locator('.who', { hasText: 'Me' }) }).last();
await mySlip2.scrollIntoViewIfNeeded();
await click(mySlip2.getByRole('button', { name: 'Delete' }));
await wait(900);

// 7. Settled bets + leaderboard
await goto('/?tab=settled');
await caption(s(7, 'Results'), 'After full time, bets settle automatically on the 90-minute score, including handicaps, pushes and quarter lines.');
await wait(1500);
await highlight(page.locator('.slip .slip-money').first(), 2200);
await click(page.locator('.nav a', { hasText: 'Members' }));
await caption(s(7, 'Results'), "And the big question: who's winning? The leaderboard ranks everyone by net result.");
await highlight(page.locator('.board-table tbody tr').first(), 3400);
await wait(1200);

// Outro
await page.evaluate(() => document.getElementById('demo-caption')?.classList.remove('on'));
await card('Bet smarter together',
  'SG Bools runs locally for your group. It records bets only, handles no money, and is not affiliated with Singapore Pools.', 5500);

const video = page.video();
await context.close();
await browser.close();
const silent = await video.path();
console.log(`Recorded ${((Date.now() - t0) / 1000).toFixed(1)}s, ${clicks.length} clicks. Adding click sounds...`);
await addClickSounds(silent, clicks, OUT);
fs.rmSync(tmpDir, { recursive: true, force: true });

// Safety net: remove anything the demo left behind for "Me".
const leftovers = db.prepare('SELECT id FROM bets WHERE user_id = ?').all(me.id).filter((r) => !startBetIds.has(r.id));
for (const r of leftovers) db.prepare('DELETE FROM bets WHERE id = ?').run(r.id);

console.log(`Saved ${OUT}${leftovers.length ? ` (cleaned up ${leftovers.length} leftover bet)` : ''}`);

// ---------- click sounds ----------
// Playwright records video only. To add sound without ffmpeg, replay the silent video in a real
// (off-screen) Edge window, synthesise a soft click with Web Audio at each recorded click time,
// and capture picture + sound together with MediaRecorder. No music, no voice-over.
async function addClickSounds(silentPath, clickTimes, outPath) {
  const fixDuration = fs.readFileSync('node_modules/fix-webm-duration/fix-webm-duration.js', 'utf8');
  const b = await chromium.launch({
    channel: 'msedge',
    headless: false, // headless Edge cannot decode video frames
    args: [
      '--window-position=-3000,0', '--window-size=1300,800',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ],
  });
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.route('http://mux.local/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/in.webm')) return route.fulfill({ body: fs.readFileSync(silentPath), contentType: 'video/webm' });
    if (url.endsWith('/fix.js')) return route.fulfill({ body: fixDuration, contentType: 'text/javascript' });
    return route.fulfill({
      contentType: 'text/html',
      body: '<body style="margin:0;background:#000"><video id=v src="/in.webm" playsinline style="width:1280px;height:720px"></video><script src="/fix.js"></script></body>',
    });
  });
  await p.goto('http://mux.local/');
  const base64 = await p.evaluate(async (clickTimes) => {
    const v = document.getElementById('v');
    await new Promise((r) => (v.readyState >= 3 ? r() : (v.oncanplaythrough = r)));
    const ctx = new AudioContext();
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();

    // A short, soft UI click: a falling triangle "tick" plus a tiny filtered noise transient.
    const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 3);
    const click = (at) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(1900, at);
      o.frequency.exponentialRampToValueAtTime(700, at + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.32, at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
      o.connect(g).connect(dest);
      o.start(at);
      o.stop(at + 0.09);
      const n = ctx.createBufferSource();
      n.buffer = noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;
      const ng = ctx.createGain();
      ng.gain.value = 0.12;
      n.connect(hp).connect(ng).connect(dest);
      n.start(at);
    };

    const stream = new MediaStream([...v.captureStream().getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp8,opus';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    rec.start(1000);
    await v.play();
    const start = ctx.currentTime - v.currentTime; // audio-clock time of video t=0
    for (const t of clickTimes) click(start + t);
    const t0 = performance.now();
    await new Promise((r) => (v.onended = r));
    rec.stop();
    await stopped;
    const durationMs = performance.now() - t0;
    const blob = await new Promise((r) => window.ysFixWebmDuration(new Blob(chunks, { type: mime }), durationMs, r, { logger: false }));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, clickTimes);
  await b.close();
  fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
}
