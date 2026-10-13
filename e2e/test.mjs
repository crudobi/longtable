// test.mjs — Longtable Phase 0 e2e (Appium + UiAutomator2, webdriverio).
// Proves the oath: "A stranger can install this and cook tonight with zero setup."
// Run via e2e/run-e2e.sh (sets APK env). Exit 0 = every step passed.
import { remote } from 'webdriverio';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

async function cancelForm() {
  await (await $d('//button[contains(., "Cancel")]')).click();
  await el('[data-testid="recipe-list"]');
}

async function createRecipe(title, ingredient, stepText, prep, cook) {
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
  if (prep) {
    const f = await el('[data-testid="field-prep"]');
    await f.clearValue();
    await f.setValue(prep);
  }
  if (cook) {
    const f = await el('[data-testid="field-cook"]');
    await f.clearValue();
    await f.setValue(cook);
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
  // logcat -d can exceed execFileSync's default 1MB buffer on long runs (ENOBUFS).
  const out = execFileSync(ADB, ['-s', SERIAL, 'logcat', '-d'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
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

  await step('first run: empty cookbook explains what to do next', async () => {
    const empty = await el('[data-testid="cookbook-empty"]');
    const t = await empty.getText();
    assert(t.includes('No recipes yet'), 'empty state missing the headline');
    assert(t.includes('New recipe'), 'empty state does not point at New recipe');
    assert(t.includes('Import'), 'empty state does not point at Import');
    assert(t.includes('on this device'), 'empty state does not state local storage');
    return 'welcome copy + next steps present';
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

  await step('detail view shows ingredients and steps', async () => {
    await openRecipeCard('E2E Pancakes');
    const t = await bodyText();
    assert(t.includes('flour'), 'ingredient missing from detail');
    assert(t.includes('Mix well'), 'step missing from detail');
    await backToList();
    return 'detail ok';
  });

  await step('prep/cook times saved and shown', async () => {
    await createRecipe('E2E Times', 'salt', 'Stir', '15', '30');
    await openRecipeCard('E2E Times');
    const t = await bodyText();
    assert(t.includes('15 min'), 'prep time missing from detail');
    assert(t.includes('30 min'), 'cook time missing from detail');
    await backToList();
    assert((await bodyText()).includes('E2E Times'), 'E2E Times not in list');
    return '15 min / 30 min shown';
  });

  await step('photo attach: downscaled to <=1280px and shown', async () => {
    await (await el('[data-testid="new-recipe"]')).click();
    await (await el('[data-testid="field-title"]')).setValue('E2E Photo');
    // The OS file picker can't be driven from automation, and chromedriver
    // does no client-side file detection for sendKeys. Inject the file
    // directly via DataTransfer + a bubbling change event instead: everything
    // from the input's onChange onward (FileReader, canvas downscale,
    // preview, save) is the real app pipeline.
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
    const w = await driver.executeScript(
      'var img = document.querySelector(\'img[alt="Attached photo 1"]\');' +
      'return img ? img.naturalWidth : -1;', []
    );
    assert(w > 0 && w <= 1280, `photo not downscaled to <=1280px: naturalWidth=${w}`);
    await (await el('[data-testid="save-recipe"]')).click();
    await el('[data-testid="recipe-detail"]');
    await el('img[alt="Recipe photo 1"]');
    await backToList();
    return `downscaled to ${w}px, preview + detail ok`;
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

  await step('url import: unreachable host shows graceful error', async () => {
    await (await el('[data-testid="new-recipe"]')).click();
    await (await el('[data-testid="import-url"]')).click();
    await (await el('[data-testid="field-url"]')).setValue('https://invalid.invalid/recipe');
    await (await el('[data-testid="fetch-url"]')).click();
    const status = await el('[data-testid="import-status"]', 30000);
    const msg = await status.getText();
    assert(msg.length > 10, 'import-status empty');
    // Dialog still open (did not crash or dismiss): the URL field remains.
    await el('[data-testid="field-url"]');
    await (await $d('//div[@role="dialog"]//button[contains(., "Cancel")]')).click(); // close dialog
    await cancelForm();
    return `graceful: "${msg.slice(0, 60)}"`;
  });

  await step('url import: fixture page prefills the form', async () => {
    await (await el('[data-testid="new-recipe"]')).click();
    await (await el('[data-testid="import-url"]')).click();
    await (await el('[data-testid="field-url"]')).setValue('https://10.0.2.2:18443/recipe.html');
    await (await el('[data-testid="fetch-url"]')).click();
    // Success closes the dialog and prefills the form; failure shows import-status.
    let titleVal = '';
    let errMsg = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const st = await $d('[data-testid="import-status"]');
      if (await st.isExisting()) { errMsg = await st.getText(); break; }
      titleVal = await (await $d('[data-testid="field-title"]')).getValue();
      if (titleVal) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert(!errMsg, `import failed: ${errMsg}`);
    assert(titleVal === 'Fixture Pancakes', `title not prefilled, got "${titleVal}"`);
    assert((await bodyText()).includes('200g flour'), 'ingredients not prefilled');
    await cancelForm();
    return 'prefilled title + ingredients';
  });

  await step('friends panel states the unfriend caveat plainly', async () => {
    await (await el('[data-testid="friends-open"]')).click();
    await el('[data-testid="friends-panel"]');
    const caveat = await el('[data-testid="unfriend-caveat"]');
    const t = await caveat.getText();
    assert(t.includes('stay readable'), 'caveat does not say delivered copies stay readable');
    assert(t.includes("can't read new versions"), 'caveat does not state forward-only revocation');
    await (await el('[data-testid="close-friends"]')).click();
    const panel = await $d('[data-testid="friends-panel"]');
    await panel.waitForExist({ reverse: true, timeout: 10000 });
    return 'caveat visible without starting an unfriend';
  });

  await step('import panel: JSON importer adds a recipe to the cookbook', async () => {
    await (await el('[data-testid="open-import"]')).click();
    await el('[data-testid="import-panel"]');
    // Pick the JSON importer in the registry-driven <select> (React
    // controlled component: native value setter + bubbling change).
    await driver.executeScript(
      'var s = document.querySelector(\'[data-testid="importer-select"]\');' +
      'var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;' +
      'setter.call(s, "longtable-json");' +
      's.dispatchEvent(new Event("change", { bubbles: true }));',
      []
    );
    // Feed the file input a JSON file via DataTransfer (same technique as
    // the photo step: chromedriver does no file detection for sendKeys).
    const json = JSON.stringify({
      title: 'E2E Imported Stew',
      ingredients: ['rice', 'beans'],
      steps: ['Simmer everything.'],
      prepMinutes: 10,
    });
    await driver.executeScript(
      'var file = new File([arguments[0]], "recipes.json", { type: "application/json" });' +
      'var dt = new DataTransfer(); dt.items.add(file);' +
      'var input = document.querySelector(\'[data-testid="import-file"]\');' +
      'input.files = dt.files;' +
      'input.dispatchEvent(new Event("change", { bubbles: true }));',
      [json]
    );
    await (await el('[data-testid="run-import"]')).click();
    const result = await el('[data-testid="import-result"]', 20000);
    const msg = await result.getText();
    assert(msg.includes('E2E Imported Stew'), `import result wrong: "${msg}"`);
    await (await el('[data-testid="close-import"]')).click();
    const panel = await $d('[data-testid="import-panel"]');
    await panel.waitForExist({ reverse: true, timeout: 10000 });
    assert((await bodyText()).includes('E2E Imported Stew'), 'imported recipe not in list');
    return 'imported via registry UI, listed in cookbook';
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
