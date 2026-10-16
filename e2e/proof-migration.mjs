// proof-migration.mjs — Longtable storage-migration proof (Phase 0 -> Phase 1).
//
// The test that should have existed before the storage swap: install the
// Phase 0 (Automerge) APK, seed a recipe WITH a photo through the real UI,
// then `adb install -r` the Phase 1 (Yjs) build over it and assert the
// recipe survived the upgrade — via the one-time migration in
// src/store/migrateFromAutomerge.ts — exactly once (no duplicates on
// relaunch), with title, ingredients, steps, times and photo intact.
//
// Run: node proof-migration.mjs
// Env: P0_APK (Phase 0 build, default below), APK (new build, default below),
//      SERIAL (default emulator-5554). Appium must be running on :4723
//      (e2e/run-e2e.sh starts it; this script assumes it is up).
import { remote } from 'webdriverio';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Host layout derives from this file's location (env LT_ROOT wins):
// the repo is <LT_ROOT>/code/longtable.
const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..');
const LT_ADB = process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb');
const P0_APK = process.env.P0_APK || path.join(LT_ROOT, 'builds/longtable/longtable-phase0.apk');
const NEW_APK = process.env.APK || path.join(LT_ROOT, 'builds/longtable/longtable-debug.apk');
const PKG = 'kitchen.longtable.app';
const SERIAL = process.env.SERIAL || 'emulator-5554';
const ADB = LT_ADB;
const TITLE = 'Migration Soup';

const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(name, fn) {
  process.stdout.write(`[....] ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`       PASS${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0];
    results.push({ name, ok: false, detail: msg });
    console.log(`       FAIL — ${msg}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

let driver;
const $d = (sel) => driver.$(sel);
const el = async (sel, timeout = 20000) => {
  const e = await $d(sel);
  await e.waitForExist({ timeout });
  return e;
};

async function newSession() {
  if (driver) { try { await driver.deleteSession(); } catch (_) { /* gone */ } }
  driver = await remote({
    protocol: 'http', hostname: '127.0.0.1', port: 4723, path: '/',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': SERIAL,
      'appium:appPackage': PKG,
      'appium:appActivity': `${PKG}.MainActivity`,
      'appium:noReset': true,
      'appium:autoGrantPermissions': true,
      'appium:chromedriverAutodownload': true,
      'appium:newCommandTimeout': 180,
    },
  });
  // Poll for the WebView context (DevTools socket lags app start).
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const ctxs = await driver.getContexts();
    const web = ctxs.find((c) => String(c).toLowerCase().startsWith('webview'));
    if (web) {
      try { await driver.switchContext(web); return; } catch (_) { /* retry */ }
    }
    await sleep(1500);
  }
  throw new Error('webview never appeared');
}

async function backToList() {
  await (await el('//button[contains(., "Recipes")]')).click();
  await el('[data-testid="recipe-list"]');
}

async function countCards(title) {
  const cards = await driver.$$(`//span[text()="${title}"]`);
  return cards.length;
}

async function attachPhoto() {
  // Same technique as the e2e gate: chromedriver can't drive the OS picker,
  // so inject the fixture JPEG via DataTransfer + bubbling change event.
  const b64 = readFileSync(new URL('./fixtures/photo.jpg', import.meta.url)).toString('base64');
  await driver.executeScript(
    'var b64 = arguments[0];' +
    'var bin = atob(b64);' +
    'var arr = new Uint8Array(bin.length);' +
    'for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);' +
    'var file = new File([arr], "photo.jpg", { type: "image/jpeg" });' +
    'var dt = new DataTransfer(); dt.items.add(file);' +
    'var input = document.querySelector(\'[data-testid="field-photos"]\');' +
    'input.files = dt.files;' +
    'input.dispatchEvent(new Event("change", { bubbles: true }));',
    [b64]
  );
  await el('img[alt="Attached photo 1"]', 30000);
}

async function main() {
  adb('logcat', '-c');

  await step('clean install Phase 0 (Automerge) APK', async () => {
    try { adb('uninstall', PKG); } catch (_) { /* not installed */ }
    adb('install', P0_APK);
    return P0_APK;
  });

  await step('Phase 0: seed recipe with photo via UI', async () => {
    await newSession();
    await el('[data-testid="recipe-list"]');
    await (await el('[data-testid="new-recipe"]')).click();
    await (await el('[data-testid="field-title"]')).setValue(TITLE);
    await (await el('[data-testid="field-ingredient"]')).setValue('1 onion');
    await (await el('[data-testid="add-ingredient"]')).click();
    await (await el('[data-testid="field-step"]')).setValue('Chop finely.');
    await (await el('[data-testid="add-step"]')).click();
    const prep = await el('[data-testid="field-prep"]');
    await prep.clearValue(); await prep.setValue('5');
    const cook = await el('[data-testid="field-cook"]');
    await cook.clearValue(); await cook.setValue('15');
    await attachPhoto();
    await (await el('[data-testid="save-recipe"]')).click();
    await el('[data-testid="recipe-detail"]');
    const t = await (await $d('[data-testid="recipe-title"]')).getText();
    assert(t === TITLE, `detail title "${t}" != "${TITLE}"`);
    await el('img[alt="Recipe photo 1"]');
    await backToList();
    assert((await countCards(TITLE)) === 1, 'seeded recipe not listed once');
    // Let the Automerge repo flush its IndexedDB writes before force-stop.
    await sleep(5000);
    return 'seeded + flushed';
  });

  await step('upgrade: adb install -r Phase 1 build over Phase 0 data', async () => {
    if (driver) { try { await driver.deleteSession(); } catch (_) { /* gone */ } driver = undefined; }
    adb('shell', 'am', 'force-stop', PKG);
    const out = adb('install', '-r', NEW_APK);
    assert(/Success/.test(out), `install -r failed: ${out.trim()}`);
    return NEW_APK;
  });

  await step('Phase 1: migrated recipe appears exactly once', async () => {
    await newSession();
    await el('[data-testid="recipe-list"]');
    // Migration runs on first launch before the list renders; poll briefly.
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < 30000) {
      n = await countCards(TITLE);
      if (n >= 1) break;
      await sleep(1500);
    }
    assert(n === 1, `expected exactly 1 "${TITLE}" card, saw ${n}`);
    return 'listed once';
  });

  await step('Phase 1: detail intact (ingredients, steps, times, photo)', async () => {
    const card = await el(`//span[text()="${TITLE}"]/ancestor::button`);
    await card.click();
    await el('[data-testid="recipe-detail"]');
    const text = await (await $d('body')).getText();
    assert(text.includes('1 onion'), 'ingredient "1 onion" missing from detail');
    assert(text.includes('Chop finely.'), 'step "Chop finely." missing from detail');
    assert(text.includes('5 min'), 'prep time missing from detail');
    assert(text.includes('15 min'), 'cook time missing from detail');
    const img = await el('img[alt="Recipe photo 1"]');
    const w = await driver.executeScript(
      'var img = document.querySelector(\'img[alt="Recipe photo 1"]\');' +
      'return img ? img.naturalWidth : -1;', []
    );
    assert(w > 0, `migrated photo not rendered (naturalWidth=${w})`);
    await backToList();
    return `photo naturalWidth=${w}`;
  });

  await step('Phase 1: migration flag recorded (imported=1)', async () => {
    const flag = await driver.executeScript(
      'return localStorage.getItem("longtable:migrated-from-automerge");', []
    );
    assert(flag, 'migration flag missing in localStorage');
    assert(flag.includes('"imported":1'), `unexpected flag value: ${flag}`);
    return flag;
  });

  await step('Phase 1: relaunch does not duplicate the migrated recipe', async () => {
    if (driver) { try { await driver.deleteSession(); } catch (_) { /* gone */ } driver = undefined; }
    adb('shell', 'am', 'force-stop', PKG);
    await sleep(1000);
    await newSession();
    await el('[data-testid="recipe-list"]');
    await sleep(2000);
    const n = await countCards(TITLE);
    assert(n === 1, `after relaunch expected 1 card, saw ${n}`);
    return 'still exactly 1';
  });

  await step('no fatal crash', async () => {
    const out = execFileSync(ADB, ['-s', SERIAL, 'logcat', '-d'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const fatals = out.split('\n').filter((l) => l.includes('FATAL EXCEPTION') && l.includes(PKG));
    assert(fatals.length === 0, fatals[0]);
    return 'logcat clean';
  });

  const passed = results.filter((r) => r.ok).length;
  console.log(`==== migration proof: ${passed}/${results.length} steps passed ====`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('FAILED STEPS:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  if (driver) { try { await driver.deleteSession(); } catch (_) { /* gone */ } }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('proof-migration crashed:', e);
  process.exit(2);
});
