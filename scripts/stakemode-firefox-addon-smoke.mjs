/** Focused actual packaged Firefox add-on UI proof; no external sites/accounts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startAcceptanceFixture } from './stakemode-acceptance-fixture.ts';
import { jpegDimensions } from '../workspace/protocol.ts';
import { getFirefoxOwnerDiagnostics } from '../firefox-runtime.ts';

const output = resolve('artifacts'), images = join(output, 'stakemode-firefox-addon-smoke');
await mkdir(images, { recursive: true });
const report = { product: 'StakeMode', version: '0.1.0-preview.2', gate: 'packaged-firefox-addon-ui',
  source: process.env.GITHUB_SHA ?? null, platform: process.platform, architecture: process.arch,
  startedAt: new Date().toISOString(), passed: false, cleanupConfirmed: false,
  executionBudgetMs: 120000, cleanupBudgetMs: 30000,
  scope: 'One actual owned Firefox profile; fresh local harmless XPI; no external sites, accounts, credentials or wagers.',
  progress: [], pages: [], controlErrors: [], streamFrames: 0 };
const deadline = Date.now() + report.executionBudgetMs;
let fixture, setupPromise, inspector, connectionPromise, socket, token, expired = false;
let frameSequence = -1, lastFrame, latestFrameUrl, socketAuthenticated = false;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
function budget() { if (expired || Date.now() >= deadline) throw new Error('Firefox add-on smoke exceeded its 120-second execution budget'); }
async function persist() { await writeFile(join(output, 'STAKEMODE-FIREFOX-ADDON-SMOKE.json'), `${JSON.stringify(report, null, 2)}\n`); }
async function checkpoint(phase) {
  report.lastCheckpoint = { phase, at: new Date().toISOString() };
  report.progress.push(report.lastCheckpoint);
  try { await persist(); } catch { report.reportWriteFailed = true; console.error('Firefox add-on smoke checkpoint could not be written'); }
  console.log(`FIREFOX-ADDON ${phase}`);
}
async function bounded(task, milliseconds, label) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), Math.max(1, milliseconds)); })]); }
  finally { clearTimeout(timer); }
}
async function observe(task, label, milliseconds = 5000) {
  budget();
  const value = await bounded(task, Math.max(1, Math.min(milliseconds, deadline - Date.now())), label);
  budget(); return value;
}
async function waitFor(label, predicate, milliseconds = 15000) {
  const end = Math.min(deadline, Date.now() + milliseconds);
  while (Date.now() < end) { if (await observe(predicate, label, Math.min(3000, end - Date.now()))) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function api(operation, body, authorization = true) {
  budget();
  const base = new URL(fixture.runtime.url);
  assert.equal(base.origin, 'http://127.0.0.1:8080');
  const url = new URL(`/workspace/api/${operation}`, base);
  assert.equal(url.origin, base.origin); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = { 'X-StakeMode-Workspace': '1', accept: 'application/json', Connection: 'close',
    ...(authorization ? { authorization: `Bearer ${token}` } : {}),
    ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) };
  const value = await new Promise((done, reject) => {
    let request, complete = false;
    const finish = (error, result) => { if (complete) return; complete = true; clearTimeout(timer); if (error) { request?.destroy(); reject(error); } else done(result); };
    const timer = setTimeout(() => finish(new Error(`Local API operation timed out: ${operation.split('/').at(-1)}`)), Math.max(1, Math.min(operation === 'start' ? 75000 : 20000, deadline - Date.now())));
    request = httpRequest(url, { method: payload ? 'POST' : 'GET', headers, agent: false }, response => {
      const chunks = []; let size = 0;
      response.on('data', bytes => { size += bytes.length; if (size > 2 * 1024 * 1024) { response.destroy(); finish(new Error('Local API response exceeded its bound')); } else chunks.push(Buffer.from(bytes)); });
      response.once('aborted', () => finish(new Error('Local API response aborted')));
      response.once('error', () => finish(new Error('Local API response failed')));
      response.once('end', () => {
        try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(response.statusCode, 200, `Local API rejected ${operation.split('/').at(-1)}: ${result.error ?? 'unexpected status'}`); finish(undefined, result); }
        catch (error) { finish(error); }
      });
    });
    request.once('error', () => finish(new Error('Local API connection failed')));
    request.end(payload);
  });
  budget(); return value;
}
function control(profileId, packet) {
  budget(); assert.equal(socket?.readyState, WebSocket.OPEN); assert.equal(socketAuthenticated, true);
  socket.send(JSON.stringify({ type: 'CONTROL', profileId, ...packet }));
}
async function nativeDisplay(page) {
  const result = await observe(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height,
    desktop: /Windows NT/.test(navigator.userAgent) && !/Mobile|Android|iPhone|iPad|Tablet/.test(navigator.userAgent) })), 'exact Firefox desktop dimensions');
  assert.deepEqual(result, { width: 1473, height: 913, screenWidth: 1473, screenHeight: 913, desktop: true });
  return result;
}
async function pixels(page, kind, phase) {
  const bytes = await observe(() => page.screenshot({ type: 'jpeg', scale: 'css', timeout: 3000 }), 'real native package pixels', 4000);
  const dimensions = jpegDimensions(bytes);
  assert.deepEqual(dimensions, { width: 1473, height: 913 }); assert.ok(bytes.length > 5000, 'A real rendered package image is required');
  const filename = `${kind}-${phase}.jpg`; await writeFile(join(images, filename), bytes);
  return { filename, bytes: bytes.length, sha256: hash(bytes), ...dimensions };
}
async function run() {
  await checkpoint('fixture.start');
  setupPromise = startAcceptanceFixture();
  setupPromise.then(value => { fixture = value; }, () => {});
  fixture = await setupPromise; budget();
  report.engine = { name: 'firefox', version: fixture.metadata.firefox.version, executableSha256: fixture.metadata.firefox.sha256,
    upstreamArchiveSha256: fixture.metadata.firefox.archiveSha256, extensionUiPatch: fixture.metadata.firefox.extensionUiPatch };
  assert.equal(report.engine.extensionUiPatch.patchId, 'stakemode-firefox-extension-ui-v1');
  const runtimeRoot = resolve(process.env.ALIASMODE_PLAYWRIGHT_RUNTIME);
  const playwright = await import(pathToFileURL(join(runtimeRoot, 'node_modules/playwright-core/index.mjs')).href); budget();
  const bootstrap = await api('bootstrap', undefined, false); token = bootstrap.token;
  assert.equal(typeof token, 'string'); assert.ok(token.length >= 32);
  const relayUrl = new URL(bootstrap.relayUrl);
  assert.equal(relayUrl.origin, 'ws://127.0.0.1:8080'); assert.equal(relayUrl.pathname, '/relay'); assert.equal(relayUrl.search, '');
  socket = new WebSocket(relayUrl.href);
  socket.addEventListener('message', event => {
    try {
      const packet = JSON.parse(event.data);
      if (packet.type === 'PING') socket.send(JSON.stringify({ type: 'PONG' }));
      if (packet.type === 'SNAPSHOT') socketAuthenticated = true;
      if (packet.type === 'CONTROL_ERROR') report.controlErrors.push({ profileId: packet.profileId, error: String(packet.error).slice(0, 200) });
      if (packet.type === 'FRAME') {
        const dimensions = jpegDimensions(Buffer.from(packet.jpeg, 'base64'));
        assert.equal(dimensions.width, packet.width); assert.equal(dimensions.height, packet.height);
        latestFrameUrl = packet.url;
        let address; try { const url = new URL(packet.url); address = { scheme: url.protocol, entrypoint: /^(?:moz|chrome)-extension:$/.test(url.protocol) ? url.pathname : '[local-page]' }; } catch { address = { scheme: '[unavailable]' }; }
        frameSequence = packet.sequence; lastFrame = { profileId: packet.profileId, sequence: packet.sequence, at: packet.at, ...address, ...dimensions };
        report.streamFrames++;
      }
    } catch { report.streamError = 'Invalid authenticated relay packet or JPEG geometry'; }
  });
  await waitFor('authenticated relay opens', () => socket.readyState === WebSocket.OPEN, 5000);
  socket.send(JSON.stringify({ type: 'HELLO', client: 'dashboard', token }));
  await waitFor('authenticated workspace snapshot', () => socketAuthenticated, 5000);
  await api('settings', { origins: [fixture.origin], pacing: 'fast' });
  await checkpoint('addon.import-and-review');
  const files = fixture.createAddonFixtures();
  const imported = (await api('extensions/import', { path: files.firefoxXpi, engine: 'firefox' })).extension;
  assert.match(imported.sha256, /^[a-f0-9]{64}$/);
  report.addon = { sha256: imported.sha256, engine: imported.engine, sourceFormat: imported.sourceFormat, loadMode: imported.loadMode };
  const profile = (await api('bulk', { count: 1, prefix: 'Firefox add-on smoke', engine: 'firefox', urls: [fixture.pageUrl], origin: fixture.origin,
    networkMode: 'direct', ramMb: 4096, heapMb: 512, resolutions: ['1280x720'], headless: true })).profiles[0];
  assert.ok(profile?.id); report.profileId = profile.id;
  await api(`profiles/${profile.id}/screen`, { width: 1473, height: 913 });
  const extensionPath = `profiles/${profile.id}/extensions`;
  await api(extensionPath, { extensionId: imported.id, enabled: true, siteAccess: 'sites', origins: [fixture.origin], reviewedSha256: imported.sha256 });
  await checkpoint('firefox.start-one-profile');
  await api('start', { profileId: profile.id });
  assert.equal(fixture.runtime.store.listLaunches().length, 1); assert.equal(fixture.runtime.store.listLaunches()[0].engine, 'firefox');
  connectionPromise = fixture.connectProfile(profile.id, playwright);
  connectionPromise.then(value => { inspector = value; }, () => {});
  inspector = await observe(() => connectionPromise, 'attach actual native Firefox', 20000);
  report.desktop = await nativeDisplay(inspector.page);
  await waitFor('actual installed add-on content marker', () => inspector.page.evaluate(() => document.documentElement.dataset.stakemodeAddon === 'firefox-preview2'));
  report.nativeContentMarker = true;
  await api('manual', { profileId: profile.id, enabled: true });
  const original = (await api(`profiles/${profile.id}/browser`)).browser.tabs.find(tab => tab.url === fixture.pageUrl); assert.ok(original);
  socket.send(JSON.stringify({ type: 'SUBSCRIBE', profileIds: [profile.id] }));
  socket.send(JSON.stringify({ type: 'FOCUS', profileId: profile.id }));
  for (const kind of ['popup', 'options']) {
    await checkpoint(`addon.${kind}.open`);
    const result = { kind, passed: false }; report.pages.push(result);
    const beforeSequence = frameSequence;
    const openedResponse = await api(`${extensionPath}/${imported.id}/open`, { kind });
    result.openError = openedResponse.browser.error ?? null;
    let opened;
    await waitFor(`actual Firefox ${kind} title`, async () => {
      const browser = (await api(`profiles/${profile.id}/browser`)).browser;
      result.browserError = browser.error ?? null;
      opened = browser.tabs.find(tab => tab.title === `StakeMode firefox ${kind} fixture`); return !!opened;
    }, 10000);
    assert.match(opened.url, new RegExp(`^moz-extension://[a-f0-9-]{36}/${kind}\\.html$`));
    const page = inspector.context.pages().find(item => item.url() === opened.url); assert.ok(page, 'Exact native installed extension URL exists');
    assert.equal(await observe(() => page.title(), 'native extension title'), `StakeMode firefox ${kind} fixture`);
    assert.equal(await observe(() => page.locator('[data-testid="extension-ui"]').textContent(), 'native extension marker'), `firefox-preview2:${kind}`);
    result.exactNativeUrl = true; result.runtimeScheme = 'moz-extension:'; result.entrypoint = `${kind}.html`;
    result.desktop = await nativeDisplay(page);
    result.beforePixels = await pixels(page, kind, 'before');
    await waitFor('authenticated live stream renders the exact native extension page', () => latestFrameUrl === opened.url && lastFrame?.profileId === profile.id && lastFrame.sequence > beforeSequence && lastFrame.width === 1473 && lastFrame.height === 913, 7000);
    result.liveFrame = { ...lastFrame };
    const input = page.locator('[data-testid="extension-filter"]'), button = page.locator('[data-testid="extension-button"]');
    const inputBounds = await observe(() => input.boundingBox(), 'native input bounds'), buttonBounds = await observe(() => button.boundingBox(), 'native button bounds');
    assert.ok(inputBounds && buttonBounds);
    control(profile.id, { kind: 'click', x: inputBounds.x + inputBounds.width / 2, y: inputBounds.y + inputBounds.height / 2 });
    await waitFor('authenticated manual input focus', () => input.evaluate(node => node === document.activeElement), 5000);
    control(profile.id, { kind: 'text', text: `public ${kind} filter` });
    await waitFor('authenticated manual package text', async () => await input.inputValue() === `public ${kind} filter`, 5000);
    control(profile.id, { kind: 'click', x: buttonBounds.x + buttonBounds.width / 2, y: buttonBounds.y + buttonBounds.height / 2 });
    await waitFor('authenticated manual package click', async () => await page.locator('[data-testid="extension-count"]').textContent() === '1', 5000);
    result.afterPixels = await pixels(page, kind, 'after');
    assert.notEqual(result.beforePixels.sha256, result.afterPixels.sha256, 'Actual rendered package pixels change after manual text and click');
    assert.deepEqual(report.controlErrors, []); assert.equal(report.streamError, undefined);
    result.authenticatedManualTextAndClick = true; result.passed = true;
    await api(`profiles/${profile.id}/browser`, { action: 'close-tab', tabId: opened.id });
    await api(`profiles/${profile.id}/browser`, { action: 'select-tab', tabId: original.id });
    await checkpoint(`addon.${kind}.passed`);
  }
  report.checksPassed = true;
}
let mainTimer;
const main = run();
try {
  await Promise.race([main, new Promise((_, reject) => { mainTimer = setTimeout(() => { expired = true; reject(new Error('Firefox add-on smoke exceeded its 120-second execution budget')); }, Math.max(1, deadline - Date.now())); })]);
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Firefox add-on smoke failed';
  console.error(report.error);
  if (inspector) {
    report.failureNativePages = await Promise.all(inspector.context.pages().slice(0, 4).map(async page => {
      let address;
      try { const url = new URL(page.url()); address = { scheme: url.protocol, entrypoint: url.protocol === 'moz-extension:' ? url.pathname : '[local-page]' }; } catch { address = { scheme: '[unavailable]' }; }
      if (Date.now() >= deadline) return { ...address, observation: 'execution-budget-exhausted' };
      try { return { ...address, ...await bounded(() => page.evaluate(() => ({ title: document.title.slice(0, 160), marker: document.querySelector('[data-testid="extension-ui"]')?.textContent?.slice(0, 160) ?? null, netError: document.documentURI.startsWith('about:neterror') })), Math.min(1500, deadline - Date.now()), 'bounded native failure diagnostic') }; }
      catch { return { ...address, unavailable: true }; }
    }));
  }
} finally {
  clearTimeout(mainTimer); expired = true;
  await checkpoint('cleanup.begin');
  const cleanupDeadline = Date.now() + report.cleanupBudgetMs;
  const cleanupBound = (task, label) => bounded(task, Math.max(1, cleanupDeadline - Date.now()), label);
  const cleanupErrors = [];
  async function attemptCleanup(task, label) {
    try { await cleanupBound(task, label); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : label); }
  }
  {
    // Allow a timed-out setup/attachment to finish only so its owned handles can
    // be closed. Main's budget checks prohibit any subsequent test mutations.
    socket?.close();
    if (setupPromise && !fixture) await attemptCleanup(async () => { fixture = await setupPromise; }, 'fixture setup before cleanup');
    if (connectionPromise && !inspector) await attemptCleanup(async () => { inspector = await connectionPromise; }, 'native attachment before cleanup');
    if (inspector) await attemptCleanup(() => inspector.browser.close(), 'detach native observer');
    if (fixture) await attemptCleanup(() => fixture.close(), 'verified owned Firefox cleanup');
    await attemptCleanup(() => main.catch(() => {}), 'settled test operations');
    report.cleanupConfirmed = cleanupErrors.length === 0;
    if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
  }
  report.passed = report.checksPassed === true && report.cleanupConfirmed && !report.streamError && !report.reportWriteFailed && report.controlErrors.length === 0;
  report.finishedAt = new Date().toISOString();
  report.firefoxOwnerDiagnostics = getFirefoxOwnerDiagnostics();
  await checkpoint('cleanup.complete');
  if (report.reportWriteFailed) report.passed = false;
  await persist();
}
// This CI harness never broad-kills processes after unknown ownership. Persist
// cleanup uncertainty before ending even if a rejected runtime remains open.
process.exit(report.passed ? 0 : 1);
