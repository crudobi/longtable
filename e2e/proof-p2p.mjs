/**
 * Phase 1 P2P proof: two emulators converge on the same recipe with no server
 * storing it. TEMPORARY proof script (not part of the e2e gate).
 *
 * Flow:
 *   1. A creates "P2P Pancakes", shares it (QR payload via UI).
 *   2. B joins via pasted payload; assert B lists the recipe.
 *   3. PARTITION: force-stop both apps + kill signaling server.
 *   4. Relaunch both (no signaling = no connection). A renames title,
 *      B adds an ingredient — concurrent offline edits.
 *   5. Restart signaling; relaunch apps; wait for sync.
 *   6. Assert BOTH devices show the merged recipe with zero field loss.
 *
 * Run: node proof-p2p.mjs
 * Requires: signaling server controllable via tmux lt-signaling (we kill/start it).
 */
import { remote } from 'webdriverio';
import { execFileSync } from 'node:child_process';

import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Host layout derives from this file's location (env LT_ROOT wins):
// the repo is <LT_ROOT>/code/longtable.
const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..')
const LT_ADB = process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb')
const ADB = LT_ADB;
const PKG = 'kitchen.longtable.app';
const SIGNAL_TMUX = 'lt-signaling';
const SIGNAL_CMD = 'node ' + path.join(LT_REPO, 'signaling/server.mjs');

const adb = (serial, ...args) =>
  execFileSync(ADB, ['-s', serial, ...args], { stdio: 'pipe' }).toString();

function makeDriver(udid) {
  return remote({
    protocol: 'http', hostname: '127.0.0.1', port: 4723, path: '/',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': udid,
      'appium:appPackage': PKG,
      'appium:appActivity': `${PKG}.MainActivity`,
      'appium:noReset': true,
      'appium:chromedriverAutodownload': true,
      'appium:newCommandTimeout': 180,
    },
  });
}

async function webview(driver, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const ctxs = await driver.getContexts();
    const web = ctxs.find((c) => String(c).toLowerCase().startsWith('webview'));
    if (web) {
      try { await driver.switchContext(web); return; }
      catch { /* retry */ }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: webview never appeared`);
}

const el = (driver, sel, timeout = 15000) =>
  driver.$(sel).then(async (e) => { await e.waitForExist({ timeout }); return e; });

async function backToList(driver) {
  // The list header has the "Recipes" back button in detail; from modals use close.
  for (let i = 0; i < 4; i++) {
    try {
      const list = await driver.$('[data-testid="recipe-list"]');
      if (await list.isExisting()) return;
    } catch { /* ignore */ }
    await driver.back().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 800));
  }
}

function signaling(action) {
  // action: 'kill' | 'start'
  if (action === 'kill') {
    execFileSync('tmux', ['kill-session', '-t', SIGNAL_TMUX], { stdio: 'ignore' });
  } else {
    try { execFileSync('tmux', ['kill-session', '-t', SIGNAL_TMUX], { stdio: 'ignore' }); } catch { /* already dead */ }
    execFileSync('tmux', ['new', '-s', SIGNAL_TMUX, '-d', SIGNAL_CMD], { stdio: 'ignore' });
  }
}

function launch(serial) {
  adb(serial, 'shell', 'am', 'start', '-n', `${PKG}/${PKG}.MainActivity`);
}
function forceStop(serial) {
  adb(serial, 'shell', 'am', 'force-stop', PKG);
}

let failures = 0;
async function step(name, fn) {
  process.stdout.write(`[....] ${name}\n`);
  try {
    const detail = await fn();
    console.log(`       PASS — ${detail}`);
  } catch (e) {
    failures++;
    console.log(`       FAIL — ${String(e.message || e).split('\n')[0]}`);
  }
}

const A = 'emulator-5554';
const B = 'emulator-5556';
let driverA, driverB;
let recipeId = null;

try {
  // Fresh state on both
  forceStop(A); forceStop(B);
  adb(A, 'shell', 'pm', 'clear', PKG);
  adb(B, 'shell', 'pm', 'clear', PKG);
  launch(A); launch(B);

  driverA = await makeDriver(A);
  driverB = await makeDriver(B);
  await webview(driverA, 'A');
  await webview(driverB, 'B');

  // 1. A creates a recipe
  await step('A creates "P2P Pancakes"', async () => {
    await (await el(driverA, '[data-testid="new-recipe"]')).click();
    await (await el(driverA, '[data-testid="field-title"]')).setValue('P2P Pancakes');
    for (const ing of ['2 cups flour', '1 tsp salt']) {
      await (await el(driverA, '[data-testid="field-ingredient"]')).setValue(ing);
      await (await el(driverA, '[data-testid="add-ingredient"]')).click();
    }
    for (const st of ['Mix well.', 'Cook.']) {
      await (await el(driverA, '[data-testid="field-step"]')).setValue(st);
      await (await el(driverA, '[data-testid="add-step"]')).click();
    }
    await (await el(driverA, '[data-testid="save-recipe"]')).click();
    await el(driverA, '[data-testid="recipe-detail"]');
    return 'created';
  });

  // 2. A shares -> capture payload
  let payload = null;
  await step('A shares the recipe (QR payload)', async () => {
    await (await el(driverA, '[data-testid="share-recipe"]')).click();
    await el(driverA, '[data-testid="share-modal"]');
    await el(driverA, '[data-testid="share-qr"]');
    payload = await driverA.executeScript(
      'return document.querySelector(\'[data-testid="share-code"]\').value;', []
    );
    if (!payload || !payload.includes('longtable-share-')) throw new Error('payload missing room');
    recipeId = (JSON.parse(payload)).recipeId;
    await (await el(driverA, '[data-testid="close-share"]')).click();
    await backToList(driverA);
    // Flush wait: localStorage share must hit disk before any force-stop.
    await new Promise((r) => setTimeout(r, 10000));
    return `room ${(JSON.parse(payload)).room}`;
  });

  // 3. B joins
  await step('B joins via pasted code', async () => {
    // DOM clicks for the modal flow: coordinate clicks on these buttons
    // are intermittently swallowed/misdirected in this emulator +
    // chromedriver environment (Phase 4 proof-hubfail diagnostics: a
    // coordinate click on Join could land on the adjacent Cancel,
    // closing the modal with no join and no error). Same real elements,
    // same assertions below.
    await driverB.executeScript(
      'document.querySelector(\'[data-testid="join-recipe"]\')?.click();', []
    );
    await el(driverB, '[data-testid="join-modal"]');
    await (await el(driverB, '[data-testid="join-code"]')).setValue(payload);
    await driverB.executeScript(
      'document.querySelector(\'[data-testid="join-confirm"]\')?.click();', []
    );
    // Wait for the recipe to appear in B's list (sync may take a few seconds)
    const t0 = Date.now();
    let found = false;
    while (Date.now() - t0 < 30000) {
      await backToList(driverB).catch(() => undefined);
      try {
        const items = await driverB.$$('[data-testid="recipe-item"]');
        for (const it of items) {
          const txt = await it.getText();
          if (txt.includes('P2P Pancakes')) { found = true; break; }
        }
        if (found) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!found) throw new Error('B never listed the shared recipe');
    const bShares = await driverB.executeScript('return localStorage.getItem("longtable:shares");', []);
    if (!bShares || !bShares.includes(recipeId)) throw new Error('B join did not persist share: ' + bShares);
    // Let localStorage flush to disk: force-stop before the flush loses the
    // saved share (Chromium batches LevelDB writes; ~10-15s is safe).
    await new Promise((r) => setTimeout(r, 15000));
    return 'B lists "P2P Pancakes", share persisted+flushed';
  });

  // 4. PARTITION: kill apps + signaling
  await step('partition: force-stop both apps, kill signaling', async () => {
    await driverA.deleteSession().catch(() => undefined);
    await driverB.deleteSession().catch(() => undefined);
    driverA = driverB = null;
    forceStop(A); forceStop(B);
    signaling('kill');
    await new Promise((r) => setTimeout(r, 2000));
    return 'no peer connection possible';
  });

  // 5. Relaunch (no signaling), concurrent offline edits
  await step('A renames title while partitioned', async () => {
    launch(A);
    driverA = await makeDriver(A);
    await webview(driverA, 'A2');
    await el(driverA, '[data-testid="recipe-list"]', 30000);
    await el(driverA, '[data-testid="recipe-item"]', 30000);
    // Open the recipe and edit the title
    const items = await driverA.$$('[data-testid="recipe-item"]');
    let opened = false;
    for (const it of items) {
      if ((await it.getText()).includes('P2P Pancakes')) { await it.click(); opened = true; break; }
    }
    if (!opened) throw new Error('A lost the recipe after relaunch');
    await el(driverA, '[data-testid="recipe-detail"]');
    await (await el(driverA, '[data-testid="edit-recipe"]')).click();
    const title = await el(driverA, '[data-testid="field-title"]');
    await title.setValue('P2P Pancakes REMIXED');
    await (await el(driverA, '[data-testid="save-recipe"]')).click();
    await el(driverA, '[data-testid="recipe-detail"]');
    await backToList(driverA);
    return 'title -> "P2P Pancakes REMIXED"';
  });

  await step('B adds ingredient while partitioned', async () => {
    launch(B);
    driverB = await makeDriver(B);
    await webview(driverB, 'B2');
    // Wait for the list to actually render before interacting
    await el(driverB, '[data-testid="recipe-list"]', 30000);
    await el(driverB, '[data-testid="recipe-item"]', 30000);
    const items = await driverB.$$('[data-testid="recipe-item"]');
    let opened = false;
    for (const it of items) {
      if ((await it.getText()).includes('P2P Pancakes')) { await it.click(); opened = true; break; }
    }
    if (!opened) throw new Error('B lost the recipe after relaunch');
    await el(driverB, '[data-testid="recipe-detail"]');
    await (await el(driverB, '[data-testid="edit-recipe"]')).click();
    await (await el(driverB, '[data-testid="field-ingredient"]')).setValue('1 tbsp sugar');
    await (await el(driverB, '[data-testid="add-ingredient"]')).click();
    await (await el(driverB, '[data-testid="save-recipe"]')).click();
    await el(driverB, '[data-testid="recipe-detail"]');
    await backToList(driverB);
    return 'ingredients += "1 tbsp sugar"';
  });

  // 6. Heal: restart signaling, relaunch apps, wait for sync
  await step('heal partition, wait for sync', async () => {
    signaling('start');
    await new Promise((r) => setTimeout(r, 3000));
    await driverA.deleteSession().catch(() => undefined);
    await driverB.deleteSession().catch(() => undefined);
    forceStop(A); forceStop(B);
    launch(A); launch(B);
    driverA = await makeDriver(A);
    driverB = await makeDriver(B);
    await webview(driverA, 'A3');
    await webview(driverB, 'B3');
    return 'signaling up, apps relaunched';
  });

  // 6b. Live y-webrtc sync (works now that the test CA is installed on both
  // emulators: signaling connects, peers discover each other, and the data
  // channel carries the Yjs updates automatically — no manual hook needed).
  // Step 7 polls each device for convergence (up to 60s each); this step just
  // gives ICE a moment to establish before the first poll.
  await step('live y-webrtc sync window', async () => {
    await new Promise((r) => setTimeout(r, 15000));
    return 'peers syncing via WebRTC data channel';
  });

  // 7. Assert convergence with zero field loss on BOTH devices
  async function readRecipe(driver, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      try {
        await backToList(driver);
        const items = await driver.$$('[data-testid="recipe-item"]');
        for (const it of items) {
          const txt = await it.getText();
          if (txt.includes('P2P Pancakes')) { await it.click(); break; }
        }
        await el(driver, '[data-testid="recipe-detail"]', 10000);
        const title = await (await el(driver, '[data-testid="recipe-title"]')).getText();
        const body = await (await el(driver, '[data-testid="recipe-detail"]')).getText();
        // Converged when BOTH edits are visible
        if (title.includes('REMIXED') && body.includes('1 tbsp sugar')) {
          return { title, hasSugar: true, hasFlour: body.includes('2 cups flour') };
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`${label}: never converged`);
  }

  await step('A converged with zero field loss', async () => {
    const r = await readRecipe(driverA, 'A');
    if (!r.hasFlour) throw new Error('A lost original ingredients');
    return `title="${r.title}", sugar present, flour present`;
  });

  await step('B converged with zero field loss', async () => {
    const r = await readRecipe(driverB, 'B');
    if (!r.hasFlour) throw new Error('B lost original ingredients');
    return `title="${r.title}", sugar present, flour present`;
  });

} finally {
  try { await driverA?.deleteSession(); } catch { /* ignore */ }
  try { await driverB?.deleteSession(); } catch { /* ignore */ }
}

console.log(`==== p2p proof: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ====`);
process.exit(failures === 0 ? 0 : 1);
