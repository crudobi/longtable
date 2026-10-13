#!/usr/bin/env node
// client.mjs — a small command-line client for Longtable's localhost API.
//
// Written from docs/localhost-api.md alone; no dependencies (Node 18+).
//
// Setup:
//   1. In Longtable: Developer → Localhost API → turn it on.
//   2. Copy the token it shows:
//        export LT_API_TOKEN=<token>
//      The address defaults to http://127.0.0.1:17337; override with
//      LT_API_URL if you changed the port in the app.
//   3. From a computer, reach the device first (emulator or USB):
//        adb forward tcp:17337 tcp:17337
//
// Usage:
//   node client.mjs health
//   node client.mjs identity
//   node client.mjs friends
//   node client.mjs list
//   node client.mjs search <words...>
//   node client.mjs get <recipe-id>
//   node client.mjs create <recipe.json>
//   node client.mjs update <recipe-id> <recipe.json>
//   node client.mjs delete <recipe-id>
//   node client.mjs import <importer-id> <text-file>
//
// Every command prints the API's JSON response. On an API error it
// prints the error and exits 1.
import { readFileSync } from 'node:fs';

const base = (process.env.LT_API_URL || 'http://127.0.0.1:17337').replace(/\/+$/, '');
const token = process.env.LT_API_TOKEN || '';

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    console.error(
      `could not reach the API at ${base} — is Longtable open with the ` +
        `localhost API on? (${e.cause?.code || e.message})`,
    );
    process.exit(1);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${parsed.error || text}`);
    process.exit(1);
  }
  return parsed;
}

const [cmd, ...args] = process.argv.slice(2);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

let out;
switch (cmd) {
  case 'health':
    out = await api('GET', '/v1/health');
    break;
  case 'identity':
    out = await api('GET', '/v1/identity');
    break;
  case 'friends':
    out = await api('GET', '/v1/friends');
    break;
  case 'list':
    out = await api('GET', '/v1/recipes');
    break;
  case 'search':
    out = await api('GET', `/v1/recipes?q=${encodeURIComponent(args.join(' '))}`);
    break;
  case 'get':
    out = await api('GET', `/v1/recipes/${args[0]}`);
    break;
  case 'create':
    out = await api('POST', '/v1/recipes', readJson(args[0]));
    break;
  case 'update':
    out = await api('PUT', `/v1/recipes/${args[0]}`, readJson(args[1]));
    break;
  case 'delete':
    out = await api('DELETE', `/v1/recipes/${args[0]}`);
    break;
  case 'import':
    out = await api('POST', '/v1/import', {
      importerId: args[0],
      text: readFileSync(args[1], 'utf8'),
    });
    break;
  default:
    console.error(
      'usage: node client.mjs <health|identity|friends|list|search|get|create|update|delete|import> ...',
    );
    process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
