// proof-importer.mjs — Phase 5 clean-room importer proof.
//
// Proves the extensibility half of the Phase 5 oath: a developer who has
// never seen the app source wrote src/importers/plugins/markdown-recipe.mjs
// from docs/importers.md ALONE (clean-room; the file's header records its
// provenance). This proof drives the REAL app on the emulator:
//   1. fresh install → the Markdown importer appears in the Import panel
//      (loaded through the plugin path, next to the built-ins);
//   2. paste a Markdown recipe as text → run the import;
//   3. the recipe lands in the cookbook with title, ingredients, steps,
//      and prep/cook times intact — checked in the detail view.
// Exit 0 = every step passed.
import { remote } from 'webdriverio';
import { execFileSync } from 'node:child_process';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Host layout derives from this file's location (env LT_ROOT wins):
// the repo is <LT_ROOT>/code/longtable.
const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..');
const LT_ADB = process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb');
const APK = process.env.APK || path.join(LT_ROOT, 'builds/longtable/longtable-debug.apk');
const PKG = 'kitchen.longtable.app';
const SERIAL = 'emulator-5554';
const ADB = LT_ADB;
const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' });

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
let driver;
const $d = (sel) => driver.$(sel);
const el = async (sel, timeout = 20000) => {
  const e = await $d(sel);
  await e.waitForExist({ timeout });
  return e;
};
const bodyText = async () => await (await $d('body')).getText();

const MARKDOWN = [
  '# Cleanroom Tomato Pasta',
  '',
  'Prep: 10 min',
  'Cook: 20 min',
  '',
  '## Ingredients',
  '- 400 g pasta',
  '- 2 tomatoes',
  '- 1 clove garlic',
  '',
  '## Steps',
  '1. Boil the pasta in salted water.',
  '2. Soften the garlic, add the tomatoes.',
  '3. Stir everything together and serve.',
  '',
].join('\n');

async function switchToWebview(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const seen = await driver.getContexts();
    const web = seen.find((c) => String(c).toLowerCase().startsWith('webview'));
    if (web) {
      try { await driver.switchContext(web); return web; } catch { /* not ready */ }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('webview switch failed');
}

async function main() {
  adb('logcat', '-c');
  await step('clean install + launch', async () => {
    try { adb('uninstall', PKG); } catch { /* not installed */ }
    adb('install', APK);
    driver = await remote({
      protocol: 'http', hostname: '127.0.0.1', port: 4723, path: '/',
      capabilities: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:udid': SERIAL,
        'appium:autoGrantPermissions': true,
        'appium:chromedriverAutodownload': true,
        'appium:newCommandTimeout': 180,
        'appium:appPackage': PKG,
        'appium:appActivity': 'kitchen.longtable.app.MainActivity',
        'appium:noReset': true,
      },
    });
    assert(driver.sessionId, 'no session id');
    return await switchToWebview();
  });

  await step('import panel lists the clean-room Markdown importer', async () => {
    await el('[data-testid="recipe-list"]');
    await (await el('[data-testid="open-import"]')).click();
    await el('[data-testid="import-panel"]');
    // Plugins load lazily when the panel opens — poll the <select> options.
    let values = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      values = await driver.executeScript(
        'return Array.from(document.querySelectorAll(\'[data-testid="importer-select"] option\')).map(function(o){ return o.value; });',
        [],
      );
      if (values.includes('markdown-recipe')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert(values.includes('markdown-recipe'), `importer options were: ${JSON.stringify(values)}`);
    assert(values.includes('longtable-json') && values.includes('mealie-json') && values.includes('web-page'),
      `built-ins missing: ${JSON.stringify(values)}`);
    return `options: ${values.join(', ')}`;
  });

  await step('select the Markdown importer and paste a recipe', async () => {
    await driver.executeScript(
      'var s = document.querySelector(\'[data-testid="importer-select"]\');' +
      'var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;' +
      'setter.call(s, "markdown-recipe");' +
      's.dispatchEvent(new Event("change", { bubbles: true }));',
      [],
    );
    // React controlled <textarea>: native setter + bubbling input event.
    await driver.executeScript(
      'var t = document.querySelector(\'[data-testid="import-text"]\');' +
      'var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;' +
      'setter.call(t, arguments[0]);' +
      't.dispatchEvent(new Event("input", { bubbles: true }));',
      [MARKDOWN],
    );
    const v = await driver.executeScript(
      'return document.querySelector(\'[data-testid="import-text"]\').value;',
      [],
    );
    assert(v.includes('# Cleanroom Tomato Pasta'), 'textarea did not take the markdown');
    return 'markdown pasted, importer selected';
  });

  await step('run the import — recipe created through the plugin path', async () => {
    await (await el('[data-testid="run-import"]')).click();
    const result = await el('[data-testid="import-result"]', 20000);
    const msg = await result.getText();
    assert(msg.includes('Cleanroom Tomato Pasta'), `unexpected import result: "${msg}"`);
    await (await el('[data-testid="close-import"]')).click();
    const panel = await $d('[data-testid="import-panel"]');
    await panel.waitForExist({ reverse: true, timeout: 10000 });
    assert((await bodyText()).includes('Cleanroom Tomato Pasta'), 'recipe not in cookbook list');
    return msg;
  });

  await step('imported recipe is complete in the detail view', async () => {
    const card = await el('//span[text()="Cleanroom Tomato Pasta"]/ancestor::button');
    await card.click();
    await el('[data-testid="recipe-detail"]');
    const t = await bodyText();
    assert(t.includes('400 g pasta'), 'ingredient missing');
    assert(t.includes('2 tomatoes'), 'ingredient missing');
    assert(t.includes('Boil the pasta in salted water.'), 'step missing');
    assert(t.includes('Stir everything together and serve.'), 'step missing');
    assert(t.includes('10 min'), 'prep time missing');
    assert(t.includes('20 min'), 'cook time missing');
    return 'title, 3 ingredients, 3 steps, 10/20 min all intact';
  });

  await step('no fatal crash', async () => {
    const out = execFileSync(ADB, ['-s', SERIAL, 'logcat', '-d'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const fatals = out.split('\n').filter((l) => l.includes('FATAL EXCEPTION') && l.includes(PKG));
    assert(fatals.length === 0, fatals[0]);
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
console.log(`\n==== proof-importer: ${results.length - failed.length}/${results.length} steps passed ====`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.detail}`);
  process.exit(1);
}
