import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(appDir, 'docs', 'screenshots');
const { createAppServer } = require(path.join(appDir, 'server.js'));

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

function findChromeBinary() {
  for (const bin of CHROME_CANDIDATES) {
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('Could not find Google Chrome/Chromium binary. Set CHROME_BIN to override.');
}

class CDPSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
        const handlers = this.listeners.get(key) || [];
        for (const h of handlers) h(msg.params);
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, handler, sessionId = undefined) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(handler);
  }

  close() {
    this.ws.close();
  }
}

async function launchChrome(chromeBin, userDataDir) {
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,960',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Chrome DevTools WS. ${stderr}`)), 12000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderr}`));
    });
  });

  const cdp = new CDPSession(wsUrl);
  await cdp.connect();
  return { proc, cdp };
}

async function openContextPage(cdp, url, viewport) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: Boolean(viewport.mobile)
  }, sessionId);

  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve, sessionId));
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;

  async function evaluate(fnOrExpr) {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : fnOrExpr;
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async function waitFor(fn, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = await evaluate(fn);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 70));
    }
    throw new Error(`Timed out waiting for: ${fn.toString()}`);
  }

  async function saveShot(filename, opts = {}) {
    await new Promise((r) => setTimeout(r, 180));
    const params = { format: 'png' };
    if (opts.clip) {
      params.clip = { ...opts.clip, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (opts.fullPage) {
      const dims = await evaluate(() => ({
        w: Math.max(document.documentElement.clientWidth, document.body.scrollWidth),
        h: Math.max(document.documentElement.clientHeight, document.body.scrollHeight)
      }));
      params.clip = { x: 0, y: 0, width: dims.w, height: dims.h, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await cdp.send('Page.captureScreenshot', params, sessionId);
    const dest = path.join(shotsDir, filename);
    fs.writeFileSync(dest, Buffer.from(data, 'base64'));
    console.log(`  ✓ Saved ${path.relative(appDir, dest)}`);
  }

  async function setViewport(vp) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 2,
      mobile: Boolean(vp.mobile)
    }, sessionId);
    await new Promise((r) => setTimeout(r, 120));
  }

  return { sessionId, evaluate, waitFor, saveShot, setViewport };
}

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuelab-docs-'));
  const dbPath = path.join(tmpDir, 'docs-capture.db');
  const chromeDir = path.join(tmpDir, 'chrome');
  fs.mkdirSync(chromeDir, { recursive: true });

  const prevEnvPass = process.env.INSTRUCTOR_PASSCODE;
  delete process.env.INSTRUCTOR_PASSCODE;

  const { server, db } = createAppServer({ dbPath, staticDir: appDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Capturing CueLab Arena screenshots from isolated server ${baseUrl}...`);

  const chromeBin = findChromeBinary();
  const { proc: chromeProc, cdp } = await launchChrome(chromeBin, chromeDir);

  try {
    // ==================== 1. MAIN RACK LIBRARY ====================
    const inst = await openContextPage(cdp, baseUrl, { width: 1440, height: 960, mobile: false });
    await inst.waitFor(() => document.querySelectorAll('#gameTabs button').length === 6);

    // Advance directly to Shot 1 cleanly without animation delay
    await inst.evaluate(() => {
      window.selectRack(1, true);
      window.jumpToStroke(1);
      window.cancelAnim();
      window.computeDesiredCameraAngle(true);
      window.updateHUD();
      window.render();
    });
    await inst.saveShot('01-main-rack-library.png', { fullPage: true });

    // ==================== 9. EXPANDED MODE & BALL MAGNIFIER ====================
    await inst.setViewport({ width: 1440, height: 920, mobile: false });
    await inst.evaluate(() => {
      window.toggleExpandedMode();
      window.cycleBallSize(); // Lg
      window.toggleGridCoords();
      window.computeDesiredCameraAngle(true);
      window.render();

      // Trigger hover magnifier cleanly on the active #1-Ball via canvas pointermove
      const c = document.getElementById('poolTable');
      const rect = c.getBoundingClientRect();
      const rData = window.getRackData();
      const b1 = rData.balls.find((b) => b.number === 1);
      const wPt = window.gridToPx(b1.coord);
      const sPt = window.worldToScreen(wPt.x, wPt.y);
      const clientX = rect.left + (sPt.x / c.width) * rect.width;
      const clientY = rect.top + (sPt.y / c.height) * rect.height;
      c.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, bubbles: true }));
    });
    await inst.saveShot('09-expanded-magnifier-mode.png');

    // Reset viewing prefs before remaining captures
    await inst.evaluate(() => {
      window.toggleExpandedMode();
      window.cycleBallSize(); // XL
      window.cycleBallSize(); // Std
      window.toggleGridCoords();
      const c = document.getElementById('poolTable');
      c.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    });
    await inst.setViewport({ width: 1440, height: 960, mobile: false });

    // ==================== 2. SPIN LAB SANDBOX ====================
    await inst.evaluate(() => {
      document.getElementById('spinLabTabBtn').click();
      window.toggleSandboxTargetZone();
      // Apply low-right English to clearly demonstrate Squirt/Throw Red Miss Arrow + Green Spin Path + Cyan Target Zone
      const widget = document.getElementById('cueBallWidget');
      const rect = widget.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      widget.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: cx + rect.width * 0.24,
        clientY: cy + rect.height * 0.14,
        pointerId: 1,
        bubbles: true
      }));
      widget.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      window.computeDesiredCameraAngle(true);
      window.updateHUD();
      window.render();
    });
    await inst.saveShot('02-spin-lab-sandbox.png', { fullPage: true });

    // ==================== 3. INSTRUCTOR PASSCODE SETUP GATE ====================
    await inst.evaluate(() => {
      document.getElementById('plannerTabBtn').click();
    });
    await inst.waitFor(() => document.getElementById('instPasscodeInput') !== null);
    await inst.saveShot('03-instructor-passcode-setup.png', { clip: { x: 0, y: 0, width: 1440, height: 760 } });

    // Set demo passcode & save a Custom Spin Lab Drill with Center Target Zone
    await inst.evaluate(() => {
      document.getElementById('instPasscodeInput').value = 'demo-coach-pass';
      document.querySelector('.auth-gate-card').requestSubmit();
    });
    await inst.waitFor(() => document.getElementById('planNameInput') !== null);

    // Go save a clean Spin Lab custom drill (center-low stun draw hitting cyan zone!)
    await inst.evaluate(() => {
      document.getElementById('spinLabTabBtn').click();
      window.resetSandboxDefault();
      // Set slight draw so cue ball stops nicely near center table and mark Target Zone right there
      const widget = document.getElementById('cueBallWidget');
      const rect = widget.getBoundingClientRect();
      widget.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height * 0.68,
        pointerId: 2,
        bubbles: true
      }));
      widget.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true }));
      window.toggleSandboxTargetZone();
      window.openSaveCustomDrillModal();
    });
    await inst.waitFor(() => document.getElementById('sbDrillTitleInput') !== null);
    await inst.evaluate(() => {
      document.getElementById('sbDrillTitleInput').value = 'Corner Cut Stun-Draw to Center Zone';
      document.getElementById('sbDrillNoteInput').value = 'Pocket the 1-Ball in P3 with low-center stun-draw so the cue ball settles inside the cyan target zone.';
      document.querySelector('#cuelabModalBackdrop form').requestSubmit();
    });
    await inst.waitFor(() => !document.getElementById('cuelabModalBackdrop').classList.contains('open'));

    // ==================== 4. PRACTICE PLAN BUILDER ====================
    await inst.evaluate(() => document.getElementById('plannerTabBtn').click());
    await inst.waitFor(() => document.getElementById('planNameInput') !== null);

    await inst.evaluate(async () => {
      const nameIn = document.getElementById('planNameInput');
      nameIn.value = 'Lesson 4 — Leave Zones & Cut Control';
      nameIn.dispatchEvent(new Event('input', { bubbles: true }));

      const descIn = document.getElementById('planDescInput');
      descIn.value = 'Focus on speed control and holding cue-ball position zones before Tuesday lesson.';
      descIn.dispatchEvent(new Event('input', { bubbles: true }));

      window.setPickerSourceType('rack_shot');
      window.addPickedDrillToPlan();

      window.setPickerSourceType('custom_drill');
      window.addPickedDrillToPlan();

      window.updatePlanDrillTarget(0, 'targetAttempts', 10);
      window.updatePlanDrillTarget(0, 'targetSuccesses', 7);
      window.updatePlanDrillField(0, 'coachNote', 'Land the cue ball in the marked zone on 7 out of 10 attempts. Keep your stroke level and smooth.');

      window.updatePlanDrillTarget(1, 'targetAttempts', 5);
      window.updatePlanDrillTarget(1, 'targetSuccesses', 3);
      window.updatePlanDrillField(1, 'coachNote', 'Pocket the 1-ball into P3 and hold the cue ball inside the cyan target zone without bumping the 8-ball.');

      await window.savePracticePlan();
    });
    await inst.waitFor(() => document.querySelectorAll('.plan-list-items .list-item-card').length === 1);
    await inst.evaluate(() => document.getElementById('cuelabToast')?.classList.remove('show'));
    await inst.saveShot('04-practice-plan-builder.png', { fullPage: true });

    // ==================== 5. STUDENT LINK SHARING MODAL ====================
    await inst.evaluate(() => {
      const shareBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Share with Student'));
      shareBtn.click();
    });
    await inst.waitFor(() => document.getElementById('modalStudentNameInput') !== null);
    await inst.evaluate(() => {
      document.getElementById('modalStudentNameInput').value = 'Alex Rivera';
      document.querySelector('#cuelabModalBackdrop form').requestSubmit();
    });
    const alexUrl = await inst.waitFor(() => {
      const codeEl = document.querySelector('#modalCreatedLinkArea .share-url-code');
      return codeEl ? codeEl.textContent.trim() : null;
    });
    await inst.saveShot('05-student-link-sharing.png', { clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await inst.evaluate(() => window.closeCueLabModal());

    // Also create a second student ("Jordan Lee") for multi-student review showcase
    await inst.evaluate(() => {
      const shareBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Share with Student'));
      shareBtn.click();
    });
    await inst.waitFor(() => document.getElementById('modalStudentNameInput') !== null);
    await inst.evaluate(() => {
      document.getElementById('modalStudentNameInput').value = 'Jordan Lee';
      document.querySelector('#cuelabModalBackdrop form').requestSubmit();
    });
    const jordanUrl = await inst.waitFor(() => {
      const codeEl = document.querySelector('#modalCreatedLinkArea .share-url-code');
      return codeEl ? codeEl.textContent.trim() : null;
    });
    await inst.evaluate(() => window.closeCueLabModal());

    // ==================== 6 & 7. STUDENT MOBILE VIEW ====================
    const stu1 = await openContextPage(cdp, alexUrl, { width: 390, height: 844, mobile: true });
    await stu1.waitFor(() => document.querySelectorAll('.student-drill-tab').length === 2);

    // Log 3 quick initial attempts so the mobile active view looks alive and clear
    await stu1.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tap-attempt-btn.btn-make').click(); await sleep(60);
      document.querySelector('.tap-attempt-btn.btn-miss').click(); await sleep(60);
      document.querySelector('.tap-attempt-btn.btn-make').click(); await sleep(80);
      window.scrollTo(0, 0);
    });
    await stu1.saveShot('06-student-mobile-practice.png', { clip: { x: 0, y: 0, width: 390, height: 980 } });

    // Complete Drill 1 (6 of 10 successful -> Target Not Met, Target was 7) + note
    await stu1.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rest = [true, false, true, true, false, true, false];
      for (const ok of rest) {
        document.querySelector(ok ? '.tap-attempt-btn.btn-make' : '.tap-attempt-btn.btn-miss').click();
        await sleep(55);
      }
      const noteEl = document.getElementById('studentDrillNoteInput');
      noteEl.value = 'Hit speed 3 too firm on attempts 2 and 5; speed 2 held the cyan zone consistently.';
      noteEl.dispatchEvent(new Event('input', { bubbles: true }));
      window.flushStudentNoteSave();
      await sleep(160);
      document.getElementById('studentAttemptPanel').scrollIntoView({ behavior: 'instant', block: 'start' });
      window.scrollBy(0, -14);
    });
    await stu1.waitFor(() => (document.querySelector('.student-target-headline')?.textContent || '').includes('6 of 10'));
    await stu1.saveShot('07-student-mobile-complete.png');

    // Complete Drill 2 for Alex (4 of 5 successful -> Target Met!) + note
    await stu1.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.selectStudentDrill(1);
      await sleep(100);
      for (const ok of [true, true, false, true, true]) {
        document.querySelector(ok ? '.tap-attempt-btn.btn-make' : '.tap-attempt-btn.btn-miss').click();
        await sleep(55);
      }
      const noteEl = document.getElementById('studentDrillNoteInput');
      noteEl.value = 'Low-center stun-draw felt repeatable! Cleared the 8-ball blocker cleanly.';
      noteEl.dispatchEvent(new Event('input', { bubbles: true }));
      window.flushStudentNoteSave();
      await sleep(160);
    });

    // Log 2 attempts for Jordan Lee so the instructor dashboard shows separate multi-student results
    const stu2 = await openContextPage(cdp, jordanUrl, { width: 390, height: 844, mobile: true });
    await stu2.waitFor(() => document.querySelectorAll('.student-drill-tab').length === 2);
    await stu2.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tap-attempt-btn.btn-make').click(); await sleep(60);
      document.querySelector('.tap-attempt-btn.btn-make').click(); await sleep(60);
      const noteEl = document.getElementById('studentDrillNoteInput');
      noteEl.value = 'Warming up on Drill 1 now — finishing the rest tonight.';
      noteEl.dispatchEvent(new Event('input', { bubbles: true }));
      window.flushStudentNoteSave();
      await sleep(160);
    });

    // ==================== 8. INSTRUCTOR RESULTS REVIEW ====================
    await inst.evaluate(async () => {
      await window.setPlannerSubtab('assignments');
      await window.refreshPlannerNow();
      const cards = [...document.querySelectorAll('.assign-list-items .list-item-card')];
      const alexCard = cards.find((c) => c.textContent.includes('Alex Rivera'));
      if (alexCard) alexCard.click();
      await new Promise((r) => setTimeout(r, 150));
      window.scrollTo(0, 0);
    });
    await inst.waitFor(() => (document.querySelector('.planner-detail-card')?.innerText || '').includes('Alex Rivera'));
    await inst.evaluate(() => document.getElementById('cuelabToast')?.classList.remove('show'));
    await inst.saveShot('08-instructor-results-review.png', { fullPage: true });

    console.log('All 9 high-resolution documentation screenshots captured cleanly!');
  } finally {
    try { cdp.close(); } catch {}
    const exited = new Promise((resolve) => {
      if (chromeProc.exitCode !== null) return resolve();
      chromeProc.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    chromeProc.kill('SIGTERM');
    await exited;
    server.close();
    db.close();
    if (prevEnvPass !== undefined) process.env.INSTRUCTOR_PASSCODE = prevEnvPass;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
}

main().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
