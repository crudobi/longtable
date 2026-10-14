#!/usr/bin/env node
// Functional network verification for one emulator (NOT a proof): inside the
// app's WebView, open the signaling WebSocket (wss://10.0.2.2:4444), fetch
// the fixture HTTPS page (https://10.0.2.2:18443/, fixture-CA trusted), and
// gather WebRTC ICE candidates with the fleet TURN/STUN config. Exits 0 only
// if all three work. This catches the failure class file-level checks cannot
// see: CA present but WiFi never associated, TLS distrusted, ICE dead.
// Used by e2e/run-fleet.sh as the net-verify step of fleet provisioning;
// requires Appium + fixture HTTPS + signaling + TURN already up.
import { remote } from 'webdriverio'

const APPIUM = 'http://127.0.0.1:4723'
const ACTIVITY = 'kitchen.longtable.app.MainActivity'
const udid = process.argv[2]
if (!udid) { console.error('usage: probe-net.mjs <serial>'); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const driver = await remote({
  hostname: '127.0.0.1', port: 4723, path: '/', logLevel: 'error',
  capabilities: {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:udid': udid,
    'appium:appPackage': 'kitchen.longtable.app',
    'appium:appActivity': ACTIVITY,
    'appium:noReset': true,
    'appium:autoLaunch': false,
    'appium:chromedriverAutodownload': true,
  },
})
try {
  await driver.execute('mobile: startActivity', { component: `kitchen.longtable.app/${ACTIVITY}` })
  await sleep(2000)
  const contexts = await driver.getContexts()
  const webview = contexts.find((c) => c.startsWith('WEBVIEW'))
  await driver.switchContext(webview)
  const el = await driver.$('[data-testid="new-recipe"]')
  await el.waitForExist({ timeout: 30000 })
  const start = `
    window.__probe = { ws: 'pending', https: 'pending', ice: 'pending', cands: [] };
    try {
      const ws = new WebSocket('wss://10.0.2.2:4444');
      const t = setTimeout(() => { if (window.__probe.ws === 'pending') window.__probe.ws = 'timeout'; }, 5000);
      ws.onopen = () => { window.__probe.ws = 'open'; clearTimeout(t); try { ws.close(); } catch {} };
      ws.onerror = () => { window.__probe.ws = 'error'; clearTimeout(t); };
    } catch (e) { window.__probe.ws = 'throw:' + e.message; }
    fetch('https://10.0.2.2:18443/')
      .then((r) => { window.__probe.https = 'status ' + r.status; })
      .catch((e) => { window.__probe.https = 'error:' + e.message; });
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:10.0.2.2:3478', username: 'longtable', credential: 'dev-turn-password' }, { urls: 'stun:10.0.2.2:3478' }] });
      pc.createDataChannel('probe');
      pc.onicecandidate = (ev) => { if (ev.candidate) window.__probe.cands.push(ev.candidate.type + '/' + ev.candidate.protocol); };
      pc.onicegatheringstatechange = () => { window.__probe.ice = pc.iceGatheringState; };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { window.__probe.ice = 'offer-error:' + e.message; });
    } catch (e) { window.__probe.ice = 'throw:' + e.message; }
    'started'
  `
  await driver.executeScript('return eval(arguments[0])', [start])
  await sleep(8000)
  const res = await driver.executeScript('return eval(arguments[0])', ['JSON.stringify(window.__probe)'])
  console.log(udid, res)
  const p = JSON.parse(res)
  if (p.ws !== 'open' || p.https !== 'status 200' || p.ice !== 'complete') {
    console.error(`${udid} network probe FAILED`)
    process.exitCode = 1
  }
} finally {
  try { await driver.deleteSession() } catch { /* ignore */ }
}
