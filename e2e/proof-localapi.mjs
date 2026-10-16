// proof-localapi.mjs — E9 localhost API proof.
//
// Proves the last unbuilt element of E9 end to end, on the emulator,
// against the REAL app:
//   1. the API is off by default — nothing listens on the port;
//   2. enabling it in Developer settings (the real UI) shows the
//      address + token, and the socket binds 127.0.0.1 ONLY (checked
//      in /proc/net/tcp, not just believed);
//   3. auth: health is open; everything else is 401 without the token
//      and with a wrong token, 200 with the right one;
//   4. the docs-only example client (examples/localhost-api/client.mjs,
//      written from docs/localhost-api.md) drives the whole story:
//      create → visible in the app UI → search by title and ingredient
//      → get → update → UI reflects it → import (Markdown importer)
//      → identity/friends shapes → delete → gone from UI and API;
//   5. tier honesty over the wire: friends-only is 422, public without
//      a publishing sign-in is 422, and neither writes anything;
//   6. disabling in settings stops the socket.
// Exit 0 = every step passed.
// Assumes: emulator booted and Appium up (e2e/run-e2e.sh arranges both).
import { remote } from 'webdriverio';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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
const CLIENT = path.join(LT_REPO, 'examples/localhost-api/client.mjs');
const PORT = 17337;
const BASE = `http://127.0.0.1:${PORT}`;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let driver;
const $d = (sel) => driver.$(sel);
const el = async (sel, timeout = 20000) => {
  const e = await $d(sel);
  await e.waitForExist({ timeout });
  return e;
};
const bodyText = async () => await (await $d('body')).getText();
const domClick = async (sel) => {
  await driver.executeScript(
    'var n = document.querySelector(arguments[0]); if (!n) return false; n.click(); return true;',
    [sel],
  );
};
const pollBody = async (needle, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await bodyText()).includes(needle)) return true;
    await sleep(1000);
  }
  return false;
};

async function switchToWebview(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const seen = await driver.getContexts();
    const web = seen.find((c) => String(c).toLowerCase().startsWith('webview'));
    if (web) {
      try { await driver.switchContext(web); return web; } catch { /* not ready */ }
    }
    await sleep(1500);
  }
  throw new Error('webview switch failed');
}

/** Raw HTTP against the app, through the adb loopback forward. */
async function raw(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, body: parsed, text };
}

/** Run the docs-only example client; returns its parsed JSON stdout. */
function runClient(args, token) {
  const out = execFileSync('node', [CLIENT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LT_API_TOKEN: token ?? '', LT_API_URL: BASE },
  });
  return JSON.parse(out);
}

/**
 * Local addresses of every LISTEN socket on the API port, from the
 * kernel's own tables (/proc/net/tcp + tcp6). The port is 17337 =
 * 0x43B9; state 0A is LISTEN.
 */
function listenEntries() {
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const table = adb('shell', 'cat', f);
    for (const line of table.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 3 && cols[1].endsWith(':43B9') && cols[3] === '0A') {
        out.push(cols[1]);
      }
    }
  }
  return out;
}

let token = '';
let createdId = '';
let importedId = '';

const RECIPE_JSON = '/tmp/lt-proof-recipe.json';
const RECIPE_V2_JSON = '/tmp/lt-proof-recipe-v2.json';
const RECIPE_MD = '/tmp/lt-proof-recipe.md';

async function main() {
  adb('logcat', '-c');
  try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* not set */ }
  adb('forward', `tcp:${PORT}`, `tcp:${PORT}`);

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

  await step('off by default: nothing answers on the port, no listener exists', async () => {
    await el('[data-testid="recipe-list"]');
    let answered = true;
    try {
      await raw('GET', '/v1/health', {});
    } catch {
      answered = false;
    }
    assert(!answered, 'health answered while the API should be off');
    const listeners = listenEntries();
    assert(listeners.length === 0, `unexpected listener on 17337: ${listeners[0] || ''}`);
    return 'connection refused; no :43B9 listener in tcp/tcp6 tables';
  });

  await step('enable in Developer settings: address + 64-hex token appear', async () => {
    await domClick('[data-testid="open-developer"]');
    await el('[data-testid="developer-modal"]');
    const before = await driver.executeScript(
      'return document.querySelector(\'[data-testid="localapi-toggle"]\').checked;', [],
    );
    assert(before === false, 'toggle should start unchecked');
    await domClick('[data-testid="localapi-toggle"]');
    const t0 = Date.now();
    let addr = '';
    while (Date.now() - t0 < 20000) {
      const a = await $d('[data-testid="localapi-address"]');
      if (await a.isExisting()) addr = await a.getText();
      const t = await $d('[data-testid="localapi-token"]');
      if (await t.isExisting()) token = (await t.getText()).trim();
      if (addr.includes(`127.0.0.1:${PORT}`) && /^[0-9a-f]{64}$/.test(token)) break;
      await sleep(750);
    }
    assert(addr.includes(`127.0.0.1:${PORT}`), `address shown was: ${addr}`);
    assert(/^[0-9a-f]{64}$/.test(token), `token shown was: ${token.slice(0, 12)}…`);
    const checked = await driver.executeScript(
      'return document.querySelector(\'[data-testid="localapi-toggle"]\').checked;', [],
    );
    assert(checked === true, 'toggle did not stay on');
    return `address ${addr}, token ${token.slice(0, 8)}…`;
  });

  await step('socket binds loopback only (kernel tables + in-guest probes)', async () => {
    let listeners = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      listeners = listenEntries();
      if (listeners.length) break;
      await sleep(750);
    }
    assert(listeners.length >= 1, 'no listener on 17337 after enabling');
    // Android's Java stack binds the IPv4 loopback as an IPv4-mapped
    // IPv6 socket (::ffff:127.0.0.1, in /proc/net/tcp6). Both spellings
    // are loopback-only; anything else (above all a wildcard) fails.
    const LOOPBACK = ['0100007F:43B9', '0000000000000000FFFF00000100007F:43B9'];
    for (const local of listeners) {
      assert(LOOPBACK.includes(local), `listener is NOT loopback-only: ${local}`);
    }
    // Belt and braces, from inside the guest: the app's own network
    // interfaces (eth0/wlan0) must REFUSE the port, loopback must answer.
    const ipOut = adb('shell', 'ip', '-4', 'addr');
    const ips = [...ipOut.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\//g)]
      .map((m) => m[1])
      .filter((ip) => ip !== '127.0.0.1');
    assert(ips.length >= 1, 'no non-loopback guest IPs found to probe');
    for (const ip of ips) {
      const out = adb('shell', `nc -w 2 ${ip} ${PORT} </dev/null; echo rc=$?`);
      assert(/rc=[1-9]/.test(out), `connecting via ${ip} unexpectedly succeeded`);
    }
    const loop = adb('shell', `nc -w 2 127.0.0.1 ${PORT} </dev/null; echo rc=$?`);
    assert(loop.includes('HTTP/1.1'), 'loopback probe got no HTTP answer');
    return `LISTEN ${listeners[0]}; refused on ${ips.join(', ')}; answers on 127.0.0.1`;
  });

  await step('health is open — via the docs-only example client', async () => {
    const out = runClient(['health'], '');
    assert(out.ok === true && out.version === '1', `health said: ${JSON.stringify(out)}`);
    return 'client health: ok, version 1';
  });

  await step('auth: no token → 401, wrong token → 401, right token → 200', async () => {
    const noTok = await raw('GET', '/v1/recipes', {});
    assert(noTok.status === 401, `no-token got ${noTok.status}`);
    const wrong = await raw('GET', '/v1/recipes', { token: 'deadbeef'.repeat(8) });
    assert(wrong.status === 401, `wrong-token got ${wrong.status}`);
    const right = await raw('GET', '/v1/recipes', { token });
    assert(right.status === 200, `right-token got ${right.status}`);
    assert(Array.isArray(right.body.recipes) && right.body.recipes.length === 0, 'cookbook should be empty on a fresh install');
    return '401 / 401 / 200';
  });

  await step('create via the example client → recipe appears in the app UI', async () => {
    writeFileSync(RECIPE_JSON, JSON.stringify({
      title: 'Proof Miso Noodles',
      ingredients: ['200 g noodles', '2 tbsp miso', '1 spring onion'],
      steps: ['Boil the noodles.', 'Stir in the miso.', 'Serve.'],
      prepMinutes: 5,
      cookMinutes: 10,
    }, null, 2));
    const out = runClient(['create', RECIPE_JSON], token);
    assert(out.id, `create returned no id: ${JSON.stringify(out)}`);
    createdId = out.id;
    assert(out.visibility === 'private', `default tier should be private, got ${out.visibility}`);
    await domClick('[data-testid="close-developer"]');
    const modal = await $d('[data-testid="developer-modal"]');
    await modal.waitForExist({ reverse: true, timeout: 10000 });
    assert(await pollBody('Proof Miso Noodles'), 'created recipe never appeared in the UI');
    return `id ${createdId.slice(0, 8)}… visible in the cookbook`;
  });

  await step('search via client finds it by title and by ingredient', async () => {
    const byTitle = runClient(['search', 'miso'], token);
    assert(byTitle.recipes.some((r) => r.id === createdId), 'title search missed it');
    const byIngredient = runClient(['search', 'spring onion'], token);
    assert(byIngredient.recipes.some((r) => r.id === createdId), 'ingredient search missed it');
    const none = runClient(['search', 'chocolate'], token);
    assert(none.recipes.length === 0, 'search for chocolate should be empty');
    return 'title ✓, ingredient ✓, absent term ✓';
  });

  await step('get via client returns the full recipe', async () => {
    const r = runClient(['get', createdId], token);
    assert(r.title === 'Proof Miso Noodles', `title: ${r.title}`);
    assert(r.ingredients.length === 3 && r.steps.length === 3, 'content incomplete');
    assert(r.prepMinutes === 5 && r.cookMinutes === 10, 'times wrong');
    assert(r.visibility === 'private', `visibility: ${r.visibility}`);
    return 'title, 3 ingredients, 3 steps, 5/10 min';
  });

  await step('update via client → UI reflects the new title', async () => {
    writeFileSync(RECIPE_V2_JSON, JSON.stringify({
      title: 'Proof Miso Noodles v2',
      ingredients: ['200 g noodles', '2 tbsp miso', '1 spring onion', '1 tsp sesame oil'],
      steps: ['Boil the noodles.', 'Stir in the miso.', 'Serve.'],
      prepMinutes: 5,
      cookMinutes: 10,
    }, null, 2));
    const out = runClient(['update', createdId, RECIPE_V2_JSON], token);
    assert(out.id === createdId, 'update answered a different id');
    assert(await pollBody('Proof Miso Noodles v2'), 'UI never showed the v2 title');
    const r = runClient(['get', createdId], token);
    assert(r.ingredients.length === 4, 'update did not stick');
    return 'v2 title in UI; 4 ingredients via API';
  });

  await step('import via client (Markdown importer) lands in the cookbook', async () => {
    writeFileSync(RECIPE_MD, [
      '# Proof Imported Pie',
      '',
      'Prep: 15 min',
      'Cook: 30 min',
      '',
      '## Ingredients',
      '- 1 pie crust',
      '- 3 apples',
      '',
      '## Steps',
      '1. Fill the crust with the apples.',
      '2. Bake until golden.',
      '',
    ].join('\n'));
    const out = runClient(['import', 'markdown-recipe', RECIPE_MD], token);
    assert(out.count === 1 && out.imported.length === 1, `import said: ${JSON.stringify(out)}`);
    importedId = out.imported[0];
    assert(await pollBody('Proof Imported Pie'), 'imported recipe never appeared in the UI');
    return `imported id ${importedId.slice(0, 8)}… visible in UI`;
  });

  await step('identity + friends endpoints answer in their documented shapes', async () => {
    const idn = runClient(['identity'], token);
    assert(/^did:key:z/.test(idn.did), `identity said: ${JSON.stringify(idn)}`);
    const fr = runClient(['friends'], token);
    assert(Array.isArray(fr.friends) && fr.friends.length === 0, 'fresh install should have no friends');
    return `did ${idn.did.slice(0, 20)}…; friends []`;
  });

  await step('tier honesty over the wire: friends-only 422, public-without-sign-in 422, nothing written', async () => {
    const base = { title: 'Should Not Exist', ingredients: ['x'], steps: ['y'] };
    const fo = await raw('POST', '/v1/recipes', { token, body: { ...base, visibility: 'friends-only' } });
    assert(fo.status === 422, `friends-only got ${fo.status}: ${fo.text}`);
    assert(/friends-only/i.test(fo.body.error), `friends-only message: ${fo.body.error}`);
    const pub = await raw('POST', '/v1/recipes', { token, body: { ...base, visibility: 'public' } });
    assert(pub.status === 422, `public got ${pub.status}: ${pub.text}`);
    const list = runClient(['list'], token);
    assert(!list.recipes.some((r) => r.title === 'Should Not Exist'), 'a refused create wrote a recipe');
    assert(list.recipes.length === 2, `expected the 2 proven recipes, got ${list.recipes.length}`);
    return 'both 422; cookbook still holds exactly the 2 real recipes';
  });

  await step('delete via client → gone from the API and the UI', async () => {
    const out = runClient(['delete', createdId], token);
    assert(out.deleted === true, `delete said: ${JSON.stringify(out)}`);
    let code = 0;
    try {
      runClient(['get', createdId], token);
    } catch {
      code = 1;
    }
    assert(code === 1, 'get after delete should fail (404)');
    const t0 = Date.now();
    let gone = false;
    while (Date.now() - t0 < 20000) {
      if (!(await bodyText()).includes('Proof Miso Noodles v2')) { gone = true; break; }
      await sleep(1000);
    }
    assert(gone, 'deleted recipe still shown in the UI');
    return 'get → 404; UI no longer lists it';
  });

  await step('disabling in settings stops the socket', async () => {
    await domClick('[data-testid="open-developer"]');
    await el('[data-testid="developer-modal"]');
    await domClick('[data-testid="localapi-toggle"]');
    const checked = await driver.executeScript(
      'return document.querySelector(\'[data-testid="localapi-toggle"]\').checked;', [],
    );
    assert(checked === false, 'toggle did not turn off');
    let answered = true;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try {
        await raw('GET', '/v1/health', {});
        await sleep(750);
      } catch {
        answered = false;
        break;
      }
    }
    assert(!answered, 'health still answers after disabling');
    return 'socket closed after UI disable';
  });

  await step('no fatal crash', async () => {
    const out = adb('logcat', '-d');
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
console.log(`\n==== proof-localapi: ${results.length - failed.length}/${results.length} steps passed ====`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.detail}`);
  process.exit(1);
}
