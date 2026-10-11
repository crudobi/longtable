// test.mjs — Longtable Phase 0 e2e (Appium + UiAutomator2, webdriverio).
// Proves the oath: "A stranger can install this and cook tonight with zero setup."
// Run via e2e/run-e2e.sh (sets APK env). Exit 0 = every step passed.
import { remote } from 'webdriverio';
import { execFileSync } from 'node:child_process';

const APK = process.env.APK || '/home/devbox/builds/longtable/longtable-debug.apk';
const PKG = 'kitchen.longtable.app';
const SERIAL = 'emulator-5554';
const ADB = '/home/devbox/tools/android-sdk/platform-tools/adb';

const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' });
const adbBin = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { maxBuffer: 64 * 1024 * 1024 });
const sh = (cmd) => adb('shell', ...cmd.split(' ')).replace(/\r/g, '').trim();
// driver.$ — webdriverio standalone has no global $ (that's a WDIO-runner injection).
const $d = (sel) => driver.$(sel);

const results = [];
async function step(name, fn) {
  process.stdout.write(`[....] ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`       PASS${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0];
    results.push({ name, ok: false, detail: msg });
    console.log(`       FAIL — ${msg}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const el = async (sel, timeout = 15000) => {
  const e = await $d(sel);
  await e.waitForExist({ timeout });
  return e;
};
const bodyText = async () => await (await $d('body')).getText();

let driver;
function baseCaps() {
  return {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:udid': SERIAL,
    'appium:autoGrantPermissions': true,
    'appium:chromedriverAutodownload': true,
    'appium:newCommandTimeout': 180,
  };
}
// Fresh Appium session with app data preserved (noReset). Install/uninstall
// is done explicitly with adb (first step), so session churn never wipes data.
async function newSession(caps) {
  if (driver) { try { await driver.deleteSession(); } catch (_) { /* already gone */ } }
  driver = await remote({
    protocol: 'http', hostname: '127.0.0.1', port: 4723, path: '/',
    capabilities: caps,
  });
  assert(driver.sessionId, 'no session id');
}
async function switchToWebview(timeoutMs = 60000) {
  const t0 = Date.now();
  let seen = [];
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    seen = await driver.getContexts();
    const web = seen.find((c) => String(c).toLowerCase().startsWith('webview'));
    if (web) {
      try {
        await driver.switchContext(web);
        return web;
      } catch (e) {
        lastErr = e; // DevTools socket not ready yet; keep polling.
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `webview switch failed; last: ${String((lastErr && lastErr.message) || lastErr).split('\n')[0]}; seen: ${JSON.stringify(seen)}`
  );
}

async function backToList() {
  await (await el('//button[contains(., "Recipes")]')).click();
  await el('[data-testid="recipe-list"]');
}

async function createRecipe(title, ingredient, stepText) {
  await (await el('[data-testid="new-recipe"]')).click();
  await (await el('[data-testid="field-title"]')).setValue(title);
  if (ingredient) {
    await (await el('[data-testid="field-ingredient"]')).setValue(ingredient);
    await (await el('[data-testid="add-ingredient"]')).click();
  }
  if (stepText) {
    await (await el('[data-testid="field-step"]')).setValue(stepText);
    await (await el('[data-testid="add-step"]')).click();
  }
  await (await el('[data-testid="save-recipe"]')).click();
  // App navigates to the detail view after create (not the list).
  await el('[data-testid="recipe-detail"]');
  const detailTitle = await (await $d('[data-testid="recipe-title"]')).getText();
  assert(detailTitle === title, `detail title "${detailTitle}" != "${title}"`);
  await backToList();
}

async function openRecipeCard(title) {
  const card = await el(`//span[text()="${title}"]/ancestor::button`);
  await card.click();
  await el('[data-testid="recipe-detail"]');
}

async function fatalCrashes() {
  const out = adb('logcat', '-d');
  return out.split('\n').filter((l) => l.includes('FATAL EXCEPTION') && l.includes(PKG));
}

async function main() {
  // Clean slate: fresh logcat. (App install is fresh via fullReset below.)
  adb('logcat', '-c');

  await step('appium session: clean install + launch', async () => {
    // Deterministic clean slate via adb; Appium reset semantics stay out of it.
    try { adb('uninstall', PKG); } catch (_) { /* not installed */ }
    adb('install', APK);
    await newSession({
      ...baseCaps(),
      'appium:appPackage': PKG,
      'appium:appActivity': 'kitchen.longtable.app.MainActivity',
      'appium:noReset': true,
    });
    const ctx = await switchToWebview();
    return `session ${driver.sessionId.slice(0, 8)}…, webview ${ctx}`;
  });

  await step('ui renders: header + new-recipe button', async () => {
    await el('[data-testid="recipe-list"]');
    const h1 = await (await $d('h1')).getText();
    assert(h1 === 'Longtable', `header was "${h1}"`);
    const btn = await el('[data-testid="new-recipe"]');
    assert((await btn.getText()).includes('New recipe'), 'new-recipe button label wrong');
    return 'header "Longtable", empty-state list';
  });

  await step('no fatal crash on launch', async () => {
    const fatals = await fatalCrashes();
    assert(fatals.length === 0, fatals[0]);
    return 'logcat clean';
  });

  await step('screenshot is non-blank', async () => {
    const raw = adbBin('exec-out', 'screencap');
    const m = sh('wm size').match(/(\d+)x(\d+)/);
    assert(m, 'could not parse wm size');
    const W = +m[1], H = +m[2];
    const px = W * H * 4;
    // Raw screencap may carry a small header (observed 16 bytes); skip it.
    assert(raw.length >= px, `raw screencap ${raw.length} < ${W}x${H}x4`);
    const off = raw.length - px;
    let mean = 0, n = 0;
    for (let i = off; i < raw.length; i += 4 * 997) { mean += (raw[i] + raw[i + 1] + raw[i + 2]) / 3; n++; }
    mean /= n;
    let dev = 0;
    for (let i = off; i < raw.length; i += 4 * 997) { dev += Math.abs((raw[i] + raw[i + 1] + raw[i + 2]) / 3 - mean); }
    dev /= n;
    assert(dev > 5, `mean abs deviation ${dev.toFixed(2)} — screen looks blank`);
    return `mean abs deviation ${dev.toFixed(1)} at ${W}x${H} (header ${off}B)`;
  });

  await step('create recipe "E2E Pancakes"', async () => {
    await createRecipe('E2E Pancakes', 'flour', 'Mix well');
    assert((await bodyText()).includes('E2E Pancakes'), 'recipe not in list after save');
    return 'in list';
  });

  await step('recipe persists across force-stop + relaunch', async () => {
    adb('shell', 'am', 'force-stop', PKG);
    // Force-stop kills the WebView, orphaning chromedriver's DevTools
    // connection — re-polling can't revive it. Recreate the session
    // (noReset keeps the recipe); the new session launches the app.
    await newSession({
      ...baseCaps(),
      'appium:appPackage': PKG,
      'appium:appActivity': 'kitchen.longtable.app.MainActivity',
      'appium:noReset': true,
    });
    await switchToWebview();
    await el('[data-testid="recipe-list"]');
    assert((await bodyText()).includes('E2E Pancakes'), 'recipe lost after restart');
    return 'still listed';
  });

  await step('airplane mode on', async () => {
    // Modern API (preferred); fall back to settings+broadcast on older images.
    try {
      sh('cmd connectivity airplane-mode enable');
    } catch {
      sh('settings put global airplane_mode_on 1');
      adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', 'true');
    }
    assert(sh('settings get global airplane_mode_on') === '1', 'airplane_mode_on not 1');
    return 'offline';
  });

  await step('offline: create "Offline Soup"', async () => {
    await createRecipe('Offline Soup', 'water', 'Boil');
    assert((await bodyText()).includes('Offline Soup'), 'offline recipe not in list');
    return 'in list';
  });

  await step('offline: edit title to "Offline Soup v2"', async () => {
    await openRecipeCard('Offline Soup');
    await (await el('[data-testid="edit-recipe"]')).click();
    const title = await el('[data-testid="field-title"]');
    await title.clearValue();
    await title.setValue('Offline Soup v2');
    await (await el('[data-testid="save-recipe"]')).click();
    // App navigates to the detail view after update (not the list).
    await el('[data-testid="recipe-detail"]');
    const t = await (await $d('[data-testid="recipe-title"]')).getText();
    assert(t === 'Offline Soup v2', `detail title "${t}" != "Offline Soup v2"`);
    await backToList();
    return 'renamed';
  });

  await step('offline: delete "Offline Soup v2"', async () => {
    await openRecipeCard('Offline Soup v2');
    await (await el('[data-testid="delete-recipe"]')).click();
    // window.confirm() -> native Android dialog; handle in NATIVE_APP context.
    await driver.switchContext('NATIVE_APP');
    const ok = await $d('//*[@text="OK"]');
    await ok.waitForExist({ timeout: 10000 });
    await ok.click();
    await switchToWebview();
    await el('[data-testid="recipe-list"]');
    const t = await bodyText();
    assert(!t.includes('Offline Soup'), 'deleted recipe still listed');
    assert(t.includes('E2E Pancakes'), 'E2E Pancakes went missing after delete');
    return 'deleted, E2E Pancakes intact';
  });

  await step('airplane mode off', async () => {
    try {
      sh('cmd connectivity airplane-mode disable');
    } catch {
      sh('settings put global airplane_mode_on 0');
      adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', 'false');
    }
    assert(sh('settings get global airplane_mode_on') === '0', 'airplane_mode_on not 0');
    return 'online';
  });

  await step('no fatal crash at end', async () => {
    const fatals = await fatalCrashes();
    assert(fatals.length === 0, fatals[0]);
    // Keep a final screenshot as an artifact for the run.
    await driver.saveScreenshot('/tmp/lt-e2e-final.png');
    return 'logcat clean';
  });
}

try {
  await main();
} catch (e) {
  results.push({ name: 'harness (unexpected throw)', ok: false, detail: String((e && e.message) || e).split('\n')[0] });
} finally {
  if (driver) { try { await driver.deleteSession(); } catch { /* ignore */ } }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n==== e2e: ${results.length - failed.length}/${results.length} steps passed ====`);
if (failed.length) {
  console.log('FAILED STEPS:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
