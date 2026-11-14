/** Actual Windows packaged-engine acceptance; never places real wagers. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, mkdtemp, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DESKTOP_PROTOCOL } from '../desktop-runtime.ts';
import { jpegDimensions } from '../workspace/protocol.ts';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startAcceptanceFixture } from './stakemode-acceptance-fixture.ts';
import { readResourceSnapshotDiagnostics, windowsArgv } from '../workspace/resourceMonitor.ts';
import { readHostProcessSnapshotDiagnostics } from '../launcher.ts';
import { runPlaywrightWorker } from '../playwright-runtime.ts';
import { getFirefoxOwnerDiagnostics } from '../firefox-runtime.ts';
import { runProxyAcceptance } from './stakemode-proxy-acceptance.ts';

const output = resolve('artifacts');
const screenshots = join(output, 'stakemode-screenshots');
await mkdir(screenshots, { recursive: true });
const report = { product: 'StakeMode', version: '0.1.0-preview.2', platform: process.platform, architecture: process.arch,
  source: process.env.GITHUB_SHA ?? null, startedAt: new Date().toISOString(), passed: false, cleanupConfirmed: false, checks: [],
  apiTransport: { module: 'node:http', agent: false, connection: 'close', redirects: false, retries: 0, responseLimitBytes: 2 * 1024 * 1024 },
  scope: 'Actual isolated packaged browser engines and local safe fixture; no live websites, accounts, credentials or wagers.',
  limitations: ['DOM follower events remain synthetic.', 'RAM settings are monitored budgets; Chromium V8 heap is not total process RAM.'],
};
let fixture, dashboardBrowser, dashboardContext, dashboardPage, socket;
const inspectors = [];
const received = [];
const pageErrors = [];
const failedRequests = [];
const frameCounts = new Map();
const frameErrors = [];
const latestFrameGeometry = new Map();
let token;
let timedOut = false;
const deadline = Date.now() + 12 * 60 * 1000;
let reportWrites = Promise.resolve();
async function persistReport() {
  const content = JSON.stringify(report, null, 2) + '\n';
  reportWrites = reportWrites.catch(() => {}).then(() => writeFile(join(output, 'STAKEMODE-ACCEPTANCE.json'), content));
  await reportWrites;
}
async function checkpoint(phase, fields = {}) {
  report.lastCheckpoint = { phase, at: new Date().toISOString(), ...fields };
  (report.progress ??= []).push(report.lastCheckpoint);
  if (report.progress.length > 96) report.progress.shift();
  try { await persistReport(); }
  catch { report.checkpointWriteFailed = true; console.error('Acceptance checkpoint could not be written'); }
  console.log(`PHASE ${phase}${fields.engine ? ` ${fields.engine}` : ''}`);
}
const watchdog = setTimeout(() => {
  timedOut = true;
  void checkpoint('execution-budget-exhausted').catch(error => console.error(`Acceptance checkpoint failed: ${error instanceof Error ? error.name : 'write-error'}`));
}, 12 * 60 * 1000);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
function budget() { if (timedOut || Date.now() > deadline) throw new Error('Acceptance exceeded its twelve-minute execution budget'); }
async function boundedObservation(description, observe, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(observe),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out observing: ${description}`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function waitFor(description, predicate, timeout = 20000) {
  const end = Math.min(Date.now() + timeout, deadline);
  // Predicates only observe status/DOM. Bound the observation itself so a hung
  // renderer cannot defeat this wait's deadline. Native mutations stay awaited.
  while (Date.now() < end) { budget(); if (await boundedObservation(description, predicate, Math.max(1, Math.min(5000, end - Date.now())))) return; await sleep(120); }
  throw new Error(`Timed out: ${description}`);
}
async function nativeDocumentMatches(page, expectedUrl, expectedTitle) {
  if (page.isClosed()) throw new Error('Native document closed while waiting for navigation');
  if (page.url() !== expectedUrl) return false;
  try {
    const title = await page.title();
    return page.url() === expectedUrl && title === expectedTitle;
  } catch (error) {
    // A document commit can invalidate this read. Re-observe within waitFor's
    // existing deadline; never repeat the navigation or ignore another failure.
    if (typeof error?.message === 'string' && error.message.includes('Execution context was destroyed, most likely because of a navigation')) return false;
    throw error;
  }
}
async function check(name, action) {
  budget(); const started = Date.now();
  report.activeCheck = { name, startedAt: new Date(started).toISOString() };
  await checkpoint('check-start', { check: name }); console.log(`START ${name}`);
  try {
    const details = await action(); report.checks.push({ name, passed: true, milliseconds: Date.now() - started, ...(details ? { details } : {}) });
    delete report.activeCheck; await checkpoint('check-passed', { check: name }); console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, milliseconds: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    await checkpoint('check-failed', { check: name }); throw error;
  }
}
async function freshLoopbackJson(urlValue, headers, body, timeoutMs, method = body === undefined ? 'GET' : 'POST') {
  const url = new URL(urlValue);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '8080');
  assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '');
  if (url.search) {
    if (url.pathname === '/workspace/api/library/export') {
      assert.deepEqual([...url.searchParams.keys()], ['ids']);
      assert.match(url.searchParams.get('ids') ?? '', /^[a-zA-Z0-9_-]{1,64}(?:,[a-zA-Z0-9_-]{1,64}){0,255}$/);
    } else if (/^\/workspace\/api\/jobs\/job_[a-f0-9]{32}\/output$/.test(url.pathname)) {
      assert.deepEqual([...url.searchParams.keys()], ['format']);
      assert.ok(['json', 'csv'].includes(url.searchParams.get('format')));
    } else {
      assert.match(url.pathname, /^\/workspace\/api\/profiles\/[a-zA-Z0-9_-]{1,64}\/cookies$/);
      assert.deepEqual([...url.searchParams.keys()], ['origin']);
      assert.equal(url.searchParams.get('origin'), fixture.origin, 'Cookie QA queries are limited to the approved local fixture origin');
    }
  }
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const requestHeaders = { ...headers, Connection: 'close', ...(payload ? { 'Content-Length': String(payload.byteLength) } : {}) };
  return await new Promise((resolveResponse, rejectResponse) => {
    let complete = false, request;
    const finish = (error, result) => {
      if (complete) return; complete = true; clearTimeout(timer);
      if (error) { request?.destroy(); rejectResponse(error); } else resolveResponse(result);
    };
    const timer = setTimeout(() => finish(new Error(`Fresh loopback HTTP request timed out after ${timeoutMs} ms`)), timeoutMs);
    request = httpRequest(url, { method, headers: requestHeaders, agent: false }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.byteLength;
        if (bytes > 2 * 1024 * 1024) return finish(new Error('Fresh loopback HTTP response exceeded its bound'));
        chunks.push(Buffer.from(chunk));
      });
      response.once('aborted', () => finish(new Error('Fresh loopback HTTP response was aborted')));
      response.once('error', error => finish(error));
      response.once('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return finish(new Error('Fresh loopback HTTP response was not JSON')); }
        finish(undefined, { status: response.statusCode, data });
      });
    });
    request.once('error', error => finish(error));
    request.end(payload);
  });
}
function boundedSnapshot(value) {
  return { pacing: value?.pacing, epoch: value?.epoch, profiles: Array.isArray(value?.profiles) ? value.profiles.slice(0, 12).map(row => ({
    id: row.id, state: row.state, role: row.role, connected: row.connected, queued: row.queued, pid: row.pid,
    memoryMb: row.memoryMb, cpuPercent: row.cpuPercent, metricsVerified: row.metricsVerified, metricsSampledAt: row.metricsSampledAt,
  })) : [] };
}
async function api(operation, body, expectedStatus = 200, authorization = true, method) {
  budget();
  const headers = { 'X-StakeMode-Workspace': '1', accept: 'application/json' };
  if (authorization) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const response = await freshLoopbackJson(`${fixture.runtime.url.split('/workspace/')[0]}/workspace/api/${operation}`, headers, body, operation === 'start' ? 90000 : 45000, method);
    assert.equal(response.status, expectedStatus, `${operation}: ${response.data.error ?? 'unexpected status'}`);
    return response.data;
  } catch (error) {
    const at = performance.now();
    let direct;
    try { direct = boundedSnapshot(fixture.runtime.workspace.snapshot()); }
    catch { direct = { unavailable: true }; }
    const directMilliseconds = Math.round((performance.now() - at) * 1000) / 1000;
    const last = received.findLast(packet => packet.type === 'SNAPSHOT');
    let health;
    try {
      const result = await freshLoopbackJson('http://127.0.0.1:8080/ui/api/health', { accept: 'application/json' }, undefined, 2000);
      health = { status: result.status, ok: result.data.ok, product: result.data.product, version: result.data.version, readiness: result.data.readiness };
    } catch (probeError) { health = { error: probeError instanceof Error ? probeError.message : String(probeError) }; }
    report.apiFailureDiagnostics = { operation, transport: report.apiTransport, directMilliseconds, directSnapshot: direct,
      nativeCollectors: { ownership: readHostProcessSnapshotDiagnostics(), resources: readResourceSnapshotDiagnostics() },
      lastSocketSnapshot: boundedSnapshot(last?.snapshot), frameCounts: [...frameCounts].slice(0, 12).map(([profileId, frames]) => ({ profileId, frames })), freshHealth: health };
    throw error;
  }
}
const snapshot = async () => (await api('snapshot')).snapshot;
async function profileStatus(id) { return (await snapshot()).profiles.find(profile => profile.id === id); }
async function count(page) { return Number(await page.locator('[data-testid="counter"]').textContent()); }
function fixtureAddress(value, expected) {
  try {
    const url = new URL(value);
    const local = url.origin === fixture.origin && ['/fixture', '/fixture/second', '/fixture/stalled'].includes(url.pathname);
    return { path: local ? url.pathname : value === 'about:blank' ? 'about:blank' : '[non-fixture]', hasQuery: !!url.search, hasFragment: !!url.hash, expected: value === expected };
  } catch { return { path: '[unavailable]', expected: false }; }
}
function nativeTabDiagnostics(inspector, expected) {
  return inspector.context.pages().slice(0, 24).map((page, index) => ({ index, inspector: page === inspector.page, closed: page.isClosed(), address: fixtureAddress(page.url(), expected) }));
}
async function assertDesktopDisplay(page, engine, expected, physicalPixels = false) {
  const display = await boundedObservation(`${engine} desktop display`, () => page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight }, screen: { width: screen.width, height: screen.height },
    desktopUa: /Windows NT|Macintosh|X11|Linux x86_64/.test(navigator.userAgent) && !/Mobile|Android|iPhone|iPad|iPod|Tablet|Windows Phone/i.test(navigator.userAgent),
    mobileHint: typeof navigator.userAgentData?.mobile === 'boolean' ? navigator.userAgentData.mobile : null,
  })));
  assert.deepEqual(display.viewport, expected, `${engine} uses the exact saved desktop viewport`);
  assert.equal(display.desktopUa, true, `${engine} keeps a desktop browser user agent`);
  assert.notEqual(display.mobileHint, true, `${engine} does not enable mobile user-agent hints`);
  if (engine === 'firefox') assert.deepEqual(display.screen, expected, 'Firefox screen and viewport match the exact saved dimensions');
  if (physicalPixels) {
    const jpeg = await boundedObservation(`${engine} physical desktop viewport`, () => page.screenshot({ type: 'jpeg', scale: 'css', timeout: 3000 }), 4000);
    display.physicalPixels = jpegDimensions(jpeg);
    assert.deepEqual(display.physicalPixels, expected, `${engine} renders exact desktop pixels rather than only reporting a spoofed size`);
  }
  return display;
}
async function nativeHistoryDiagnostics(inspector, expected) {
  let timer;
  try {
    const title = new URL(expected).pathname === '/fixture/second' ? 'Second local fixture' : 'Local browser acceptance';
    const value = await Promise.race([
      inspector.page.evaluate(expectedTitle => ({ length: history.length, url: location.href, titleExpected: document.title === expectedTitle }), title),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native history diagnostic exceeded its bound')), 1500); }),
    ]);
    return { historyLength: Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : null,
      address: fixtureAddress(value.url, expected), titleExpected: value.titleExpected === true };
  } catch { return { unavailable: true }; }
  finally { clearTimeout(timer); }
}
function browserDiagnostics(browser, expected) {
  return { activeTabId: browser?.activeTabId, error: browser?.error, loading: browser?.loading,
    tabs: (browser?.tabs ?? []).slice(0, 24).map(tab => ({ id: tab.id, loading: tab.loading, address: fixtureAddress(tab.url, expected) })) };
}

async function probeFixturePage() {
  const url = new URL(`${fixture.pageUrl}/second`);
  return await new Promise((resolveProbe, rejectProbe) => {
    const chunks = []; let bytes = 0;
    const request = httpRequest(url, { method: 'GET', agent: false, headers: { Connection: 'close', 'X-StakeMode-Fixture-Probe': '1' } }, response => {
      response.on('data', chunk => { bytes += chunk.byteLength; if (bytes > 65536) request.destroy(new Error('Fixture probe response exceeded its bound')); else chunks.push(Buffer.from(chunk)); });
      response.once('end', () => resolveProbe({ status: response.statusCode, completeFixture: Buffer.concat(chunks).toString('utf8').includes('<title>Second local fixture</title>'), bytes }));
      response.once('error', rejectProbe);
    });
    request.setTimeout(2000, () => request.destroy(new Error('Fresh fixture HTTP probe timed out')));
    request.once('error', rejectProbe); request.end();
  });
}
async function traceNativeNavigation(inspector, diagnostic) {
  if (inspector.launch.engine === 'firefox') return async () => {};
  const events = diagnostic.nativeProtocol = [], requests = new Map(), frames = new Set();
  let session;
  const append = event => { events.push({ at: Date.now(), ...event }); if (events.length > 80) events.shift(); };
  const local = value => { try { return new URL(value).origin === fixture.origin ? fixtureAddress(value) : null; } catch { return null; } };
  const within = async (operation, ms) => {
    let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native diagnostic timed out')), ms); })]); } finally { clearTimeout(timer); }
  };
  const close = async () => { if (session) await within(session.detach(), 1500).catch(() => {}); };
  try {
    session = await within(inspector.context.newCDPSession(inspector.page), 3000);
    session.on('Network.requestWillBeSent', event => { const address = local(event.request.url); if (!address) return; if (requests.size > 80) requests.clear(); requests.set(event.requestId, address); append({ event: 'request', address, type: event.type }); });
    session.on('Network.responseReceived', event => { const address = local(event.response.url); if (address) append({ event: 'response', address, type: event.type, status: event.response.status }); });
    session.on('Network.loadingFinished', event => { const address = requests.get(event.requestId); if (address) append({ event: 'finished', address, bytes: event.encodedDataLength }); });
    session.on('Network.loadingFailed', event => { const address = requests.get(event.requestId); if (address) append({ event: 'failed', address, canceled: !!event.canceled, category: /^net::[A-Z0-9_]+$/.test(event.errorText) ? event.errorText : 'network-failure' }); });
    session.on('Page.frameNavigated', event => { const address = local(event.frame.url); if (address) { frames.add(event.frame.id); append({ event: 'frameNavigated', address }); } });
    session.on('Page.lifecycleEvent', event => { if (frames.has(event.frameId)) append({ event: 'lifecycle', name: /^[a-zA-Z0-9]{1,40}$/.test(event.name) ? event.name : 'other' }); });
    session.on('Page.javascriptDialogOpening', event => append({ event: 'dialog', type: ['alert', 'confirm', 'prompt', 'beforeunload'].includes(event.type) ? event.type : 'other' }));
    await within(session.send('Page.enable'), 3000); await within(session.send('Network.enable'), 3000);
    await within(session.send('Page.setLifecycleEventsEnabled', { enabled: true }), 3000);
    const tree = await within(session.send('Page.getFrameTree'), 3000); frames.add(tree.frameTree.frame.id);
    diagnostic.nativeProtocolEnabled = true;
  } catch { diagnostic.nativeProtocolEnabled = false; await close(); session = undefined; }
  return close;
}
async function compareActualNodeNavigation(inspector, expected) {
  const probe = { runtime: 'packaged-node', preservedOriginalFailure: true };
  if (inspector.context.pages().filter(page => !page.isClosed()).length !== 1) return { ...probe, skipped: 'not-a-sole-native-page' };
  const read = async navigate => {
    const at = Date.now();
    try {
      const values = await runPlaywrightWorker('page', { endpoint: inspector.launch.ws, kind: 'scripts', temporary: false,
        ...(navigate ? { url: expected } : {}), timeoutMs: 15000, scripts: ['location.href', 'document.title'] }, { timeoutMs: 25000 });
      return { milliseconds: Date.now() - at, address: fixtureAddress(values?.[0], expected), titleExpected: values?.[1] === 'Second local fixture' };
    } catch (error) { return { milliseconds: Date.now() - at, failed: true, category: ['timeout', 'runtime_unavailable', 'invalid_response', 'operation_failed'].includes(error?.code) ? error.code : 'probe-failed' }; }
  };
  probe.before = await read(false); probe.navigation = await read(true);
  return probe;
}
async function disconnectInspector(browser) {
  // Public close is attachment-specific for connectOverCDP/browserType.connect.
  // It preserves the shared in-process Playwright driver; Launcher still owns native process shutdown.
  await browser?.close().catch(() => {});
}
async function readyRoles(admin, followers) {
  await api('role', { profileId: admin, role: 'admin' });
  for (const id of followers) await api('role', { profileId: id, role: 'follower' });
  await waitFor('all real profile transports active', async () => {
    const rows = (await snapshot()).profiles;
    return [admin, ...followers].every(id => rows.some(row => row.id === id && row.connected && row.origin === fixture.origin && row.role === (id === admin ? 'admin' : 'follower')));
  });
  await sleep(400);
}
async function compiledSidecarSmoke() {
  assert.equal(process.platform, 'win32', 'Compiled-sidecar smoke requires Windows');
  const repo = resolve('.'), stateRoot = await mkdtemp(join(tmpdir(), 'stakemode-compiled-smoke-'));
  const metadata = JSON.parse(await readFile(join(repo, 'src-tauri', 'generated', 'browser.json'), 'utf8'));
  const runtimeRoot = resolve(process.env.ALIASMODE_PLAYWRIGHT_RUNTIME ?? '');
  assert.ok(process.env.ALIASMODE_PLAYWRIGHT_RUNTIME, 'Explicit packaged runtime is required');
  const nonce = randomBytes(32).toString('hex');
  const executable = join(repo, 'src-tauri', 'binaries', 'stakemode-sidecar-x86_64-pc-windows-msvc.exe');
  const child = spawn(executable, ['start', '--desktop-root', stateRoot, '--state-root', stateRoot], {
    cwd: stateRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ALIASMODE_DESKTOP_NONCE: nonce, ALIASMODE_DESKTOP_VERSION: report.version,
      ALIASMODE_PLAYWRIGHT_RUNTIME: runtimeRoot, ALIASMODE_AGENT_NONCE: randomBytes(32).toString('hex'),
      CLOAKBROWSER_BINARY_PATH: join(repo, 'src-tauri', 'resources', 'cloakbrowser', metadata.executable),
      CLOAKBROWSER_BINARY_SHA256: metadata.sha256,
      ALIASMODE_FIREFOX_BINARY_PATH: join(repo, 'src-tauri', 'resources', 'firefox', metadata.firefox.executable),
      ALIASMODE_FIREFOX_BINARY_SHA256: metadata.firefox.sha256,
      ALIASMODE_ACCESS_TOKEN: '', ALIASMODE_REFRESH_TOKEN: '', ALIASMODE_DEVICE_CREDENTIAL: '', HUB_URL: '', HUB_PASSWORD: '',
      CLOAKBROWSER_DOWNLOAD_URL: '', STAKEMODE_SYNC_EXTENSION_ROOT: join(runtimeRoot, 'stakemode', 'extensions', 'stakemode-sync'),
    },
  });
  const records = [];
  let output = '', stderr = '', spawnError, exit;
  let smokeSocket;
  const exited = new Promise(resolveExit => child.once('close', (code, signal) => { exit = { code, signal }; resolveExit(exit); }));
  child.once('error', error => { spawnError = error; });
  child.stdin.on('error', () => { /* Exit/readiness checks provide the bounded failure result. */ });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 65536) { spawnError = new Error('Compiled sidecar output exceeded its bound'); return; }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      try { records.push(JSON.parse(line)); } catch { /* Non-protocol log lines do not prove readiness. */ }
      if (records.length > 100) records.shift();
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const sendShutdown = () => { if (child.exitCode === null && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: 'shutdown', nonce }) + '\n'); };
  try {
    await waitFor('compiled sidecar nonce-bound readiness', () => {
      if (spawnError) throw spawnError;
      if (exit) throw new Error(`Compiled sidecar exited before readiness (${exit.code}): ${stderr.replace(/[a-f0-9]{64}/g, '[redacted]').slice(-500)}`);
      return records.some(record => record.event === 'ready');
    }, 45000);
    const ready = records.find(record => record.event === 'ready');
    assert.equal(ready.protocol, DESKTOP_PROTOCOL); assert.equal(ready.nonce, nonce); assert.equal(ready.pid, child.pid); assert.equal(ready.port, 8080);
    const health = await (await fetch('http://127.0.0.1:8080/ui/api/health', { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(health.ok, true); assert.equal(health.product, 'StakeMode'); assert.equal(health.version, report.version); assert.equal(health.root, stateRoot); assert.equal(health.instance, nonce);
    for (const [path, contentType, minimum] of [['/', 'text/html', 1000], ['/workspace/dashboard.js', 'javascript', 1000], ['/workspace/dashboard.css', 'text/css', 1000]]) {
      const response = await fetch(`http://127.0.0.1:8080${path}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, `Compiled asset ${path}`); assert.ok(response.headers.get('content-type')?.includes(contentType));
      const content = await response.text(); assert.ok(content.length > minimum, `Compiled packaged asset ${path} is populated`);
      if (path === '/') assert.ok(content.includes('StakeMode'));
    }
    const bootstrap = await (await fetch('http://127.0.0.1:8080/workspace/api/bootstrap', { headers: { 'X-StakeMode-Workspace': '1' }, signal: AbortSignal.timeout(5000) })).json();
    assert.equal(typeof bootstrap.token, 'string'); assert.equal(bootstrap.snapshot.profiles.length, 0, 'Compiled smoke launches no browser profile');
    let nativeSnapshot;
    smokeSocket = new WebSocket(bootstrap.relayUrl);
    smokeSocket.addEventListener('message', event => {
      let packet; try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.type === 'SNAPSHOT') nativeSnapshot = packet.snapshot;
      if (packet.type === 'PING') smokeSocket.send(JSON.stringify({ type: 'PONG' }));
    });
    await waitFor('compiled relay socket connection', () => smokeSocket.readyState === WebSocket.OPEN, 10000);
    smokeSocket.send(JSON.stringify({ type: 'HELLO', client: 'dashboard', token: bootstrap.token }));
    await waitFor('compiled relay authenticated snapshot', () => !!nativeSnapshot, 10000);
    assert.equal(nativeSnapshot.profiles.length, 0);
    smokeSocket.close();
    sendShutdown();
    await waitFor('compiled sidecar shutdown-complete protocol', () => records.some(record => record.event === 'shutdown-complete'), 20000);
    const stopped = records.find(record => record.event === 'shutdown-complete'); assert.equal(stopped.protocol, DESKTOP_PROTOCOL); assert.equal(stopped.nonce, nonce);
    const result = await Promise.race([exited, sleep(20000).then(() => { throw new Error('Compiled sidecar did not exit after confirmed shutdown'); })]);
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    return { compiledMain: true, packagedAssets: true, health: true, authenticatedRelay: true, exactPid: true, shutdownAcknowledged: true, exitCode: 0, browserProfilesLaunched: 0 };
  } finally {
    smokeSocket?.close();
    if (!exit) {
      sendShutdown();
      const graceful = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]);
      if (!graceful && child.exitCode === null) {
        // Only this directly owned test child is terminated; it never launches browser profiles.
        child.kill(); await Promise.race([exited, sleep(5000)]);
      }
    }
  }
}
try {
  await check('actual compiled sidecar startup, packaged assets and desktop shutdown protocol', compiledSidecarSmoke);
  await check('prepared Windows product and isolated fixture startup', async () => {
    fixture = await startAcceptanceFixture(); assert.equal(fixture.runtime.port, 8080); assert.match(fixture.runtime.url, /^http:\/\/127\.0\.0\.1:8080\//);
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')); assert.equal(config.productName, 'StakeMode'); assert.equal(config.identifier, 'com.solomongs.stakemode');
    assert.deepEqual(config.bundle.externalBin, ['binaries/stakemode-sidecar']); assert.equal(config.bundle.createUpdaterArtifacts, false);
    report.browserHashes = { chromium: fixture.metadata.sha256, firefox: fixture.metadata.firefox.sha256, firefoxArchive: fixture.metadata.firefox.archiveSha256,
      firefoxExtensionUiPatch: fixture.metadata.firefox.extensionUiPatch };
    const addonSmoke = JSON.parse(await readFile(join(output, 'STAKEMODE-FIREFOX-ADDON-SMOKE.json'), 'utf8'));
    assert.equal(addonSmoke.source, report.source); assert.equal(addonSmoke.passed, true); assert.equal(addonSmoke.cleanupConfirmed, true);
    assert.equal(addonSmoke.engine.executableSha256, fixture.metadata.firefox.sha256);
    assert.deepEqual(addonSmoke.engine.extensionUiPatch, fixture.metadata.firefox.extensionUiPatch);
    assert.deepEqual(addonSmoke.pages.map(page => page.kind), ['popup', 'options']);
    assert.ok(addonSmoke.pages.every(page => page.passed && page.authenticatedManualTextAndClick));
    report.firefoxAddonSmoke = addonSmoke;
  });
  const runtimeRoot = resolve(process.env.ALIASMODE_PLAYWRIGHT_RUNTIME);
  const playwright = await import(pathToFileURL(join(runtimeRoot, 'node_modules', 'playwright-core', 'index.mjs')).href);
  const proxyOptions = { runtimeRoot, chromiumPath: fixture.chromiumPath, chromiumSha256: fixture.metadata.sha256, firefoxPath: fixture.firefoxPath, firefoxSha256: fixture.metadata.firefox.sha256, playwright };
  await check('HTTP authorization and authenticated WebSocket snapshot', async () => {
    const bare = await fetch('http://127.0.0.1:8080/workspace/api/bootstrap'); assert.equal(bare.status, 403);
    const foreign = await fetch('http://127.0.0.1:8080/workspace/api/bootstrap', { headers: { 'X-StakeMode-Workspace': '1', Origin: 'https://outside.example' } }); assert.equal(foreign.status, 403);
    const rejected = new WebSocket('ws://127.0.0.1:8080/relay');
    let rejectedCode; rejected.addEventListener('close', event => { rejectedCode = event.code; });
    await waitFor('unauthorized test socket opens', () => rejected.readyState === WebSocket.OPEN);
    rejected.send(JSON.stringify({ type: 'HELLO', client: 'dashboard', token: 'invalid-profile-or-dashboard-token' }));
    await waitFor('unauthorized socket is closed', () => rejected.readyState === WebSocket.CLOSED); assert.equal(rejectedCode, 4001);
    const bootstrap = await api('bootstrap', undefined, 200, false); token = bootstrap.token; assert.equal(typeof token, 'string');
    await api('snapshot', undefined, 401, false);
    assert.equal(JSON.stringify((await api('snapshot')).snapshot).includes(token), false, 'Dashboard credentials are absent from status snapshots');
    socket = new WebSocket(bootstrap.relayUrl);
    socket.addEventListener('message', event => {
      let packet; try { packet = JSON.parse(event.data); } catch { frameErrors.push('Invalid real relay JSON'); return; }
      if (packet.type !== 'FRAME') { received.push(packet); if (received.length > 300) received.shift(); }
      if (packet.type === 'FRAME') {
        try {
          const geometry = jpegDimensions(Buffer.from(packet.jpeg, 'base64'));
          const metadataMatches = packet.width === geometry.width && packet.height === geometry.height;
          if (latestFrameGeometry.size < 12 || latestFrameGeometry.has(packet.profileId)) latestFrameGeometry.set(packet.profileId, {
            profileId: packet.profileId, sequence: packet.sequence, packetWidth: packet.width, packetHeight: packet.height,
            jpegWidth: geometry.width, jpegHeight: geometry.height, metadataMatches,
          });
          if (!metadataMatches) frameErrors.push(`Frame geometry mismatch for ${packet.profileId}: metadata ${packet.width}x${packet.height}, JPEG ${geometry.width}x${geometry.height}`);
          else frameCounts.set(packet.profileId, (frameCounts.get(packet.profileId) ?? 0) + 1);
        } catch (error) { frameErrors.push(`Invalid native JPEG frame: ${error instanceof Error ? error.message : String(error)}`); }
        if (frameErrors.length > 20) frameErrors.shift();
      }
      if (packet.type === 'PING') socket.send(JSON.stringify({ type: 'PONG' }));
    });
    await waitFor('dashboard WebSocket open', () => socket.readyState === WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'HELLO', client: 'dashboard', token }));
    await waitFor('authenticated real workspace snapshot', () => received.some(packet => packet.type === 'SNAPSHOT'));
  });
  let adminId, followerId, firefoxId, libraryGroupId;
  await check('bulk creation of two Chromium and one Firefox profile', async () => {
    await api('settings', { origins: [fixture.origin], pacing: 'fast' });
    const base = { urls: [fixture.pageUrl], origin: fixture.origin, ramMb: 4096, heapMb: 512, resolutions: ['1280x720'], headless: true };
    const chromium = await api('bulk', { ...base, count: 2, prefix: 'Acceptance Chromium', engine: 'chromium' });
    const firefox = await api('bulk', { ...base, count: 1, prefix: 'Acceptance Firefox', engine: 'firefox' });
    [adminId, followerId] = chromium.profiles.map(profile => profile.id); firefoxId = firefox.profiles[0].id;
    report.approvedProfileIds = [adminId, followerId, firefoxId];
    assert.equal(new Set([adminId, followerId, firefoxId]).size, 3);
    for (const id of [adminId, followerId, firefoxId]) await api('start', { profileId: id });
    for (const id of [adminId, followerId, firefoxId]) inspectors.push(await fixture.connectProfile(id, playwright));
    assert.equal(new Set(inspectors.map(item => item.launch.userDataDir)).size, 3);
    assert.equal(new Set(inspectors.map(item => item.launch.pid)).size, 3);
    assert.ok(inspectors.every(item => item.launch.headless === true));
    report.engines = [];
    for (const item of inspectors) {
      const engine = item.launch.engine ?? 'chromium';
      const display = await assertDesktopDisplay(item.page, engine, { width: 1280, height: 720 });
      report.engines.push({ engine, pid: item.launch.pid, isolatedDirectory: true, headless: item.launch.headless, display });
    }
    return { chromium: 2, firefox: 1, distinctProfileDirectories: true, exactDesktopViewports: true, desktopUserAgents: true };
  });
  const [admin, follower, firefox] = inspectors;
  await check('real independent browser session storage', async () => {
    await admin.page.evaluate(() => localStorage.setItem('fixture-isolation', 'controller-only'));
    assert.equal(await follower.page.evaluate(() => localStorage.getItem('fixture-isolation')), null);
    assert.equal(await firefox.page.evaluate(() => localStorage.getItem('fixture-isolation')), null);
    await follower.page.evaluate(() => localStorage.setItem('fixture-isolation', 'follower-only'));
    assert.equal(await admin.page.evaluate(() => localStorage.getItem('fixture-isolation')), 'controller-only');
  });
  await check('public local organization and portable templates create fresh profiles without account state', async () => {
    libraryGroupId = (await api('library/groups', { name: 'Acceptance local group' })).group.id;
    const sourceIds = [adminId, firefoxId];
    await admin.context.addCookies([{ name: 'stakemode-fixture-cookie', value: 'source-cookie-only', url: fixture.origin }]);
    assert.equal((await follower.context.cookies(fixture.origin)).some(cookie => cookie.name === 'stakemode-fixture-cookie'), false);
    assert.equal((await firefox.context.cookies(fixture.origin)).some(cookie => cookie.name === 'stakemode-fixture-cookie'), false);
    for (const id of [adminId, followerId, firefoxId]) {
      const metadata = { groupId: libraryGroupId, tags: ['fixture', 'preview2'], notes: 'Local acceptance note', bookmarks: [{ title: 'Local safe fixture', url: fixture.pageUrl }] };
      assert.deepEqual((await api(`library/profiles/${id}`, metadata)).metadata, metadata);
    }
    const exported = (await api(`library/export?ids=${sourceIds.join(',')}`)).document;
    assert.equal(exported.kind, 'configuration-templates'); assert.equal(exported.profiles.length, 2);
    const forbidden = ['id', 'cookies', 'fingerprintSeed', 'firefox', 'username', 'password', 'twofa', 'extensions'];
    for (const template of exported.profiles) for (const key of forbidden) assert.equal(Object.hasOwn(template, key), false, `Configuration export excludes ${key}`);
    assert.equal(JSON.stringify(exported).includes('controller-only'), false, 'Live browser storage is absent from configuration export');
    assert.equal(JSON.stringify(exported).includes('source-cookie-only'), false, 'Live source cookies are absent from configuration export');
    const imported = (await api('library/import', { document: exported })).profiles;
    assert.equal(imported.length, 2);
    const copied = (await api(`profiles/${adminId}/copy`, { name: 'Acceptance fresh copy' })).profile;
    const fresh = [...imported, copied];
    assert.equal(new Set(fresh.map(row => row.id)).size, 3);
    for (const row of fresh) {
      assert.equal([adminId, followerId, firefoxId].includes(row.id), false);
      assert.equal(fixture.runtime.workspace.manager.getLaunch(row.id), null);
      const stored = fixture.runtime.store.getProfile(row.id); assert.ok(stored);
      assert.deepEqual(stored.cookies, []); assert.deepEqual(stored.extensions ?? [], []);
      assert.equal(stored.username, ''); assert.equal(stored.password, ''); assert.equal(stored.twofa, '');
      await assert.rejects(stat(fixture.runtime.launcher.userDataDir(row.id)), { code: 'ENOENT' });
      if (imported.some(item => item.id === row.id)) {
        const metadata = (await api(`library/profiles/${row.id}`)).metadata;
        assert.equal(metadata.groupId, libraryGroupId); assert.deepEqual(metadata.tags, ['fixture', 'preview2']);
        assert.deepEqual(metadata.bookmarks, [{ title: 'Local safe fixture', url: fixture.pageUrl }]);
      }
      await api(`profiles/${row.id}`, { confirmation: row.id }, 200, true, 'DELETE');
    }
    assert.equal((await admin.context.cookies(fixture.origin)).find(cookie => cookie.name === 'stakemode-fixture-cookie')?.value, 'source-cookie-only', 'Fresh copy/import and deletion preserve only the source cookie jar');
    assert.equal((await follower.context.cookies(fixture.origin)).some(cookie => cookie.name === 'stakemode-fixture-cookie'), false);
    const library = await api('library');
    assert.ok(library.groups.some(group => group.id === libraryGroupId));
    assert.ok([adminId, followerId, firefoxId].every(id => library.profiles.some(row => row.profileId === id && row.groupId === libraryGroupId && row.bookmarkCount === 1)));
    return { groupsTagsNotesBookmarks: true, exportedTemplates: 2, freshImportedIds: 2, freshCopyId: true, nativeDataDirectoriesCopied: false, accountStateExported: false };
  });
  await check('real Chromium and Firefox address, history and isolated tab controls', async () => {
    const results = [];
    socket.send(JSON.stringify({ type: 'SUBSCRIBE', profileIds: [adminId, firefoxId] }));
    for (const [id, inspector] of [[adminId, admin], [firefoxId, firefox]]) {
      const path = `profiles/${id}/browser`;
      const diagnostic = { profileId: id, engine: inspector.launch.engine ?? 'chromium', phase: 'initial-state' };
      (report.navigationDiagnostics ??= []).push(diagnostic);
      let expected = fixture.pageUrl;
      const stopTrace = await traceNativeNavigation(inspector, diagnostic);
      const command = async value => {
        diagnostic.phase = value.action;
        const entry = { action: value.action, before: nativeTabDiagnostics(inspector, expected) };
        (diagnostic.commands ??= []).push(entry);
        if (diagnostic.commands.length > 24) diagnostic.commands.shift();
        if (['reload', 'back'].includes(value.action)) entry.beforeHistory = await nativeHistoryDiagnostics(inspector, expected);
        const started = Date.now();
        try {
          const result = (await api(path, value)).browser;
          entry.api = browserDiagnostics(result, expected);
          diagnostic.api = entry.api; diagnostic.nativePages = nativeTabDiagnostics(inspector, expected);
          return result;
        } finally {
          entry.milliseconds = Date.now() - started; entry.after = nativeTabDiagnostics(inspector, expected);
          if (['reload', 'back'].includes(value.action)) entry.afterHistory = await nativeHistoryDiagnostics(inspector, expected);
        }
      };
      try {
      await api('role', { profileId: id, role: 'follower' });
      await api(path, { action: 'reload' }, 403);
      await api('manual', { profileId: id, enabled: true });
      const initial = (await api(path)).browser;
      diagnostic.api = browserDiagnostics(initial, expected); diagnostic.nativePages = nativeTabDiagnostics(inspector, expected);
      const original = initial.tabs.find(tab => tab.url === fixture.pageUrl);
      assert.ok(original, 'Actual fixture page appears as an isolated browser tab');
      await command({ action: 'select-tab', tabId: original.id });
      const privateUrl = `${fixture.pageUrl}/second?operator-fixture-query=preview2#local-fragment`;
      expected = privateUrl;
      diagnostic.fixtureHttpProbe = await probeFixturePage();
      assert.equal(diagnostic.fixtureHttpProbe.status, 200); assert.equal(diagnostic.fixtureHttpProbe.completeFixture, true);
      diagnostic.fixtureBeforeNavigation = fixture.requestDiagnostics();
      const navigated = await command({ action: 'navigate', url: privateUrl });
      assert.equal(navigated.error, undefined, `${diagnostic.engine}: native navigation API succeeds`);
      assert.equal(navigated.activeTabId, original.id, 'Navigation preserves the explicitly selected opaque tab');
      assert.equal(navigated.tabs.find(tab => tab.id === original.id)?.url, privateUrl, 'Authenticated operator state keeps the full address');
      const startupInspector = inspector.page;
      await waitFor('actual native address navigation', () => inspector.context.pages().filter(page => !page.isClosed() && page.url() === privateUrl).length === 1);
      // Startup can contain duplicate fixture tabs. Correlate the selected opaque
      // API tab with the unique native URL, rather than assuming findLast was selected.
      inspector.page = inspector.context.pages().find(page => !page.isClosed() && page.url() === privateUrl);
      assert.ok(inspector.page); assert.equal(inspector.page.url(), privateUrl);
      diagnostic.inspectorRebound = startupInspector !== inspector.page;
      diagnostic.nativePages = nativeTabDiagnostics(inspector, expected);
      assert.equal((await profileStatus(id)).role, 'manual', 'Direct navigation decouples synchronization');
      await api(path, { action: 'navigate', url: 'file:///unapproved-local-file' }, 400);
      assert.equal(inspector.page.url(), privateUrl, 'Invalid address rejection preserves the native tab');
      await command({ action: 'reload' });
      await waitFor('actual native reload', () => nativeDocumentMatches(inspector.page, privateUrl, 'Second local fixture'));
      const reloadTrace = diagnostic.commands.findLast(entry => entry.action === 'reload');
      assert.ok(Number.isSafeInteger(reloadTrace.beforeHistory.historyLength) && Number.isSafeInteger(reloadTrace.afterHistory.historyLength), 'Native reload history length is available');
      assert.equal(reloadTrace.afterHistory.historyLength, reloadTrace.beforeHistory.historyLength, 'Native reload preserves the selected tab history length');
      expected = fixture.pageUrl; await command({ action: 'back' });
      await waitFor('actual native back', () => inspector.page.url() === fixture.pageUrl);
      expected = privateUrl; await command({ action: 'forward' });
      await waitFor('actual native forward', () => inspector.page.url() === privateUrl);
      const created = await command({ action: 'new-tab', url: fixture.pageUrl });
      const extra = created.tabs.find(tab => !initial.tabs.some(old => old.id === tab.id));
      assert.ok(extra, 'New tab has a distinct native page identity'); assert.equal(created.activeTabId, extra.id);
      const extraNative = inspector.context.pages().find(page => !page.isClosed() && page.url() === fixture.pageUrl);
      assert.ok(extraNative, 'The extra native tab is correlated by its unique fixture URL');
      await assertDesktopDisplay(extraNative, inspector.launch.engine ?? 'chromium', { width: 1280, height: 720 });
      assert.equal((await command({ action: 'select-tab', tabId: original.id })).activeTabId, original.id);
      await command({ action: 'close-tab', tabId: extra.id });
      assert.equal((await api(path)).browser.tabs.some(tab => tab.id === extra.id), false);
      assert.equal(inspector.page.isClosed(), false, 'Closing the extra tab preserves the original browser page');
      expected = `${fixture.pageUrl}/stalled`;
      let navigationResult;
      const navigation = command({ action: 'navigate', url: `${fixture.pageUrl}/stalled` }).then(value => { navigationResult = { value }; }, error => { navigationResult = { error }; });
      await waitFor('native stalled page is actively loading', () => inspector.page.url() === `${fixture.pageUrl}/stalled`, 10000);
      assert.equal(navigationResult, undefined, 'Local streaming navigation is still waiting before stop-loading');
      await command({ action: 'stop' });
      await waitFor('native stop-loading releases the pending navigation', () => !!navigationResult, 10000);
      await navigation; assert.equal(navigationResult.error, undefined);
      assert.equal((await api(path)).browser.loading, false, 'Native stop ends the loading state');
      expected = fixture.pageUrl; await command({ action: 'navigate', url: fixture.pageUrl });
      await waitFor('original native fixture restored', () => inspector.page.url() === fixture.pageUrl);
      await waitFor('subscribed native browser state reaches the live operator', () => received.some(packet => packet.type === 'BROWSER_STATE' && packet.browser?.profileId === id));
      const publicPackets = received.filter(packet => packet.type === 'BROWSER_STATE' && packet.browser?.profileId === id);
      assert.ok(publicPackets.length > 0, 'Native browser state is delivered to the live operator');
      assert.ok(publicPackets.every(packet => packet.browser.redacted === true && packet.browser.tabs.every(tab => !tab.url.includes('?') && !tab.url.includes('#'))), 'Socket browser state never includes private address query or fragment');
      diagnostic.phase = 'complete'; diagnostic.nativePages = nativeTabDiagnostics(inspector, expected);
      results.push({ engine: inspector.launch.engine, navigation: true, history: true, reload: true, stopInFlightLoading: true, independentTabs: true, followerControlDenied: true, privateAddressRedactedFromSocket: true });
      } catch (error) {
        diagnostic.nativePages = nativeTabDiagnostics(inspector, expected); diagnostic.fixtureAfterNavigation = fixture.requestDiagnostics();
        if (inspector.launch.engine !== 'firefox' && diagnostic.phase === 'navigate' && new URL(expected).pathname === '/fixture/second') {
          diagnostic.actualNodeComparison = await compareActualNodeNavigation(inspector, expected);
          diagnostic.nativePagesAfterNode = nativeTabDiagnostics(inspector, expected); diagnostic.fixtureAfterNode = fixture.requestDiagnostics();
        }
        throw error;
      } finally { await stopTrace(); }
    }
    return results;
  });
  await check('private manual cookie import/export/clear stays in the selected native profile', async () => {
    const cookiePath = id => `profiles/${id}/cookies`;
    const exportedPath = id => `${cookiePath(id)}?origin=${encodeURIComponent(fixture.origin)}`;
    await api('role', { profileId: followerId, role: 'follower' });
    await api(exportedPath(followerId), undefined, 403);
    const before = await api(exportedPath(adminId));
    assert.equal(before.cookies.find(cookie => cookie.name === 'stakemode-fixture-cookie')?.value, 'source-cookie-only');
    await api(cookiePath(adminId), { action: 'import', origin: fixture.origin, cookies: [{ name: 'stakemode-import-cookie', value: 'import-cookie-only', domain: '127.0.0.1', path: '/', expires: -1, secure: false, httpOnly: false, sameSite: 'Lax' }] });
    assert.equal((await admin.context.cookies(fixture.origin)).find(cookie => cookie.name === 'stakemode-import-cookie')?.value, 'import-cookie-only', 'Private API imports into the actual selected native jar');
    const exported = await api(exportedPath(adminId));
    assert.equal(exported.cookies.find(cookie => cookie.name === 'stakemode-import-cookie')?.value, 'import-cookie-only');
    assert.equal((await api(exportedPath(firefoxId))).cookies.some(cookie => cookie.name.startsWith('stakemode-')), false);
    await api(cookiePath(adminId), { action: 'clear', origin: fixture.origin });
    assert.equal((await admin.context.cookies(fixture.origin)).some(cookie => cookie.name.startsWith('stakemode-')), false);
    assert.equal((await follower.context.cookies(fixture.origin)).some(cookie => cookie.name.startsWith('stakemode-')), false);
    assert.equal(JSON.stringify(received).includes('source-cookie-only'), false); assert.equal(JSON.stringify(received).includes('import-cookie-only'), false);
    return { followerDenied: true, actualJarImported: true, privateExport: true, exactOriginCleared: true, otherProfilesUnchanged: true, valuesBroadcast: false };
  });
  const completeJob = async id => {
    let job;
    await waitFor('bounded read-only native workflow completes', async () => {
      job = (await api(`jobs/${id}`)).job;
      if (['failed', 'timedout', 'interrupted', 'cancelled'].includes(job.status)) throw new Error(`Native read-only job ended as ${job.status}: ${job.error ?? 'no public detail'}`);
      return job.status === 'completed';
    }, 25000);
    return job;
  };
  await check('native Chromium and Firefox read-only workflows export exact fixture JSON and CSV', async () => {
    await api('manual', { profileId: adminId, enabled: true }); await api('manual', { profileId: firefoxId, enabled: true });
    const peerBefore = { count: await count(follower.page), queued: (await profileStatus(followerId)).queued };
    const library = await api('workflows');
    assert.ok(library.templates.some(template => template.key === 'inspect-current-page'));
    const workflow = (await api('workflows', { name: 'Native fixture inspection', steps: [
      { kind: 'navigate', url: fixture.pageUrl }, { kind: 'wait', ms: 50 },
      { kind: 'extract', source: 'text', selector: 'h1', field: 'heading' },
      { kind: 'extract', source: 'title', field: 'title' }, { kind: 'extract', source: 'url', field: 'url' },
      { kind: 'scroll', deltaX: 0, deltaY: 240 }, { kind: 'wait', ms: 100 },
    ] })).workflow;
    await api('role', { profileId: adminId, role: 'admin' });
    const rejectedAdmin = await api(`workflows/${workflow.id}/run`, { profileIds: [adminId] });
    assert.equal(rejectedAdmin.jobs.length, 0); assert.equal(rejectedAdmin.rejected[0]?.profileId, adminId, 'A synchronizing administrator cannot run read-only workflow actions');
    await api('manual', { profileId: adminId, enabled: true });
    const started = await api(`workflows/${workflow.id}/run`, { profileIds: [adminId, firefoxId] });
    assert.deepEqual(started.rejected, []); assert.equal(started.jobs.length, 2);
    const results = [];
    for (const startedJob of started.jobs) {
      const job = await completeJob(startedJob.id); assert.equal(job.steps.length, 7); assert.ok(job.steps.every(step => step.status === 'completed'));
      const json = await api(`jobs/${job.id}/output?format=json`), csv = await api(`jobs/${job.id}/output?format=csv`);
      assert.equal(json.format, 'json'); assert.equal(csv.format, 'csv');
      const output = JSON.parse(json.content);
      assert.deepEqual(output.values, { heading: 'Independent browser fixture', title: 'Local browser acceptance', url: fixture.pageUrl });
      assert.equal(output.profileId, startedJob.profileId);
      assert.ok(csv.content.startsWith('field,value\r\n')); assert.ok(csv.content.includes('"heading","Independent browser fixture"'));
      const inspector = job.profileId === adminId ? admin : firefox;
      await waitFor('native workflow actually scrolls its selected fixture page', () => inspector.page.evaluate(() => scrollY > 0));
      await api(`profiles/${job.profileId}/browser`, { action: 'navigate', url: fixture.pageUrl });
      results.push({ engine: inspector.launch.engine, nativeNavigationAndScroll: true, publicTextAndTitle: true, jsonValues: output.values, csvVerified: true });
    }
    await api(`workflows/${workflow.id}`, undefined, 200, true, 'DELETE');
    assert.equal(await count(follower.page), peerBefore.count); assert.equal((await profileStatus(followerId)).queued, peerBefore.queued, 'Manual workflow navigation and scroll never mirror to a follower');
    return results;
  });
  await check('native read-only workflow wait cancels immediately without an output or stale step', async () => {
    const workflow = (await api('workflows', { name: 'Native cancellation fixture', steps: [{ kind: 'wait', ms: 30000 }, { kind: 'extract', source: 'title', field: 'neverRun' }] })).workflow;
    const started = await api(`workflows/${workflow.id}/run`, { profileIds: [adminId] }); assert.deepEqual(started.rejected, []);
    const jobId = started.jobs[0].id;
    await waitFor('read-only wait job is running', async () => (await api(`jobs/${jobId}`)).job.status === 'running');
    const before = Date.now(), cancelled = (await api(`jobs/${jobId}/cancel`, {})).job;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.outputsAvailable, false);
    assert.ok(Date.now() - before < 5000, 'Cancellation does not wait for the 30-second step');
    await api(`jobs/${jobId}/output?format=json`, undefined, 400);
    await sleep(250); assert.equal((await api(`jobs/${jobId}`)).job.status, 'cancelled');
    assert.equal(await admin.page.title(), 'Local browser acceptance');
    await api(`workflows/${workflow.id}`, undefined, 200, true, 'DELETE');
    return { cancelledDuringWait: true, laterExtractionSkipped: true, outputUnavailable: true, browserRemainsUsable: true };
  });
  await check('app-open one-off schedule runs a real Firefox fixture inspection exactly once', async () => {
    await api('manual', { profileId: firefoxId, enabled: true });
    const workflow = (await api('workflows', { name: 'Native one-off fixture', steps: [{ kind: 'extract', source: 'title', field: 'scheduledTitle' }] })).workflow;
    const schedule = (await api('schedules', { workflowId: workflow.id, profileId: firefoxId, kind: 'once', runAt: Date.now() + 1500, enabled: true })).schedule;
    let job;
    await waitFor('open-app schedule creates its native Firefox job', async () => { job = (await api('jobs')).jobs.find(item => item.workflowId === workflow.id && item.trigger === 'schedule'); return !!job; }, 10000);
    job = await completeJob(job.id);
    const output = JSON.parse((await api(`jobs/${job.id}/output?format=json`)).content);
    assert.deepEqual(output.values, { scheduledTitle: 'Local browser acceptance' });
    const schedules = await api('schedules'); assert.equal(schedules.appMustRemainOpen, true);
    const consumed = schedules.schedules.find(item => item.id === schedule.id); assert.equal(consumed.enabled, false); assert.equal(consumed.lastJobId, job.id);
    assert.equal((await api('jobs')).jobs.filter(item => item.workflowId === workflow.id && item.trigger === 'schedule').length, 1);
    await api(`schedules/${schedule.id}`, undefined, 200, true, 'DELETE');
    await api(`workflows/${workflow.id}`, undefined, 200, true, 'DELETE');
    return { engine: 'firefox', actualNativeTitle: true, oneOffConsumed: true, jobs: 1, appMustRemainOpen: true };
  });
  await check('MV3 controller and Firefox binding safe click/input/scroll synchronization', async () => {
    await readyRoles(adminId, [followerId, firefoxId]);
    assert.ok(admin.context.serviceWorkers().some(worker => worker.url().startsWith('chrome-extension://')), 'Actual Chromium MV3 worker loaded');
    await admin.page.locator('[data-testid="open-panel"]').click();
    await waitFor('safe click reaches both native followers', async () => await count(follower.page) === 1 && await count(firefox.page) === 1);
    assert.equal(await admin.page.evaluate(() => window.fixtureState.lastTrusted), true);
    assert.equal(await follower.page.evaluate(() => window.fixtureState.lastTrusted), false);
    await admin.page.locator('[name="filter"]').click(); await admin.page.keyboard.insertText('accepted fixture input');
    await waitFor('safe input reaches both followers', async () => await follower.page.locator('[name="filter"]').inputValue() === 'accepted fixture input' && await firefox.page.locator('[name="filter"]').inputValue() === 'accepted fixture input');
    await admin.page.mouse.wheel(0, 520);
    await waitFor('trusted operator scroll reaches both followers', async () => {
      const positions = await Promise.all([admin.page, follower.page, firefox.page].map(page => page.evaluate(() => scrollY)));
      return positions[0] > 100 && positions.every(value => Math.abs(value - positions[0]) <= 2);
    });
    await admin.page.mouse.wheel(0, -700);
    await waitFor('return to fixture controls', async () => (await Promise.all(inspectors.map(item => item.page.evaluate(() => scrollY)))).every(value => value === 0));
  });
  await check('JPEG live views from Chromium and Firefox', async () => {
    socket.send(JSON.stringify({ type: 'SUBSCRIBE', profileIds: [adminId, followerId, firefoxId] }));
    await waitFor('all three real JPEG streams with exact physical geometry', () => {
      if (frameErrors.length) throw new Error(frameErrors[0]);
      return [adminId, followerId, firefoxId].every(id => (frameCounts.get(id) ?? 0) >= 2);
    }, 25000);
    assert.deepEqual(frameErrors, []);
    for (const id of [adminId, followerId, firefoxId]) {
      const frame = latestFrameGeometry.get(id);
      assert.deepEqual({ width: frame.jpegWidth, height: frame.jpegHeight }, { width: 1280, height: 720 }, 'Native live stream retains the saved desktop viewport');
    }
    report.frames = { chromiumController: frameCounts.get(adminId), chromiumFollower: frameCounts.get(followerId), firefox: frameCounts.get(firefoxId) };
  });
  await check('desktop and mobile dashboard render real live tiles', async () => {
    const dashboard = await fixture.openDashboard(playwright);
    dashboardBrowser = dashboard.browser; dashboardContext = dashboard.context; dashboardPage = dashboard.page;
    dashboardPage.on('pageerror', error => pageErrors.push(error.message)); dashboardPage.on('requestfailed', request => failedRequests.push({ url: request.url().split('?')[0], failure: request.failure()?.errorText }));
    const beforeForeground = await dashboardPage.evaluate(() => ({ hidden: document.hidden, visibility: document.visibilityState }));
    await dashboardPage.bringToFront();
    const afterForeground = await dashboardPage.evaluate(() => ({ hidden: document.hidden, visibility: document.visibilityState }));
    report.dashboardForeground = { before: beforeForeground, after: afterForeground };
    assert.equal(afterForeground.hidden, false, 'Foreground QA dashboard must have visible document state');
    await dashboardPage.goto(fixture.runtime.url, { waitUntil: 'domcontentloaded' });
    await dashboardPage.locator('#connection-state').filter({ hasText: 'Relay connected' }).waitFor({ timeout: 20000 });
    await waitFor('three real dashboard browser tiles', () => dashboardPage.locator('.live-tile').count().then(value => value === 3));
    await dashboardPage.locator('#metric-running').filter({ hasText: '3' }).waitFor();
    const visibleTilesHealthy = () => dashboardPage.evaluate(viewport => {
      const visible = [...document.querySelectorAll('.live-tile')].filter(tile => { const bounds = tile.getBoundingClientRect(); return bounds.bottom > 0 && bounds.top < viewport.height && bounds.right > 0 && bounds.left < viewport.width; });
      return visible.length > 0 && visible.every(tile => tile._frameHealthy === true && tile.querySelector('.stream-message')?.hidden === true && Date.now() - tile._frameAt < 10000);
    }, dashboardPage.viewportSize());
    await waitFor('visible desktop tiles have decoded healthy live JPEG frames', visibleTilesHealthy, 30000);
    await dashboardPage.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: false });
    const targetDisplays = await Promise.all(inspectors.map(item => assertDesktopDisplay(item.page, item.launch.engine ?? 'chromium', { width: 1280, height: 720 })));
    const frameSequences = new Map([adminId, followerId, firefoxId].map(id => [id, latestFrameGeometry.get(id)?.sequence ?? 0]));
    await dashboardPage.setViewportSize({ width: 390, height: 844 });
    await waitFor('visible mobile tiles have decoded healthy live JPEG frames', visibleTilesHealthy, 20000);
    const afterMobileResize = await Promise.all(inspectors.map(item => assertDesktopDisplay(item.page, item.launch.engine ?? 'chromium', { width: 1280, height: 720 })));
    assert.deepEqual(afterMobileResize, targetDisplays, 'Resizing the dashboard to a phone viewport does not resize or emulate mobile on any browser profile');
    await waitFor('fresh native frames preserve desktop size after mobile dashboard resize', () => [adminId, followerId, firefoxId].every(id => {
      const frame = latestFrameGeometry.get(id);
      return frame && frame.sequence > frameSequences.get(id) && frame.jpegWidth === 1280 && frame.jpegHeight === 720;
    }), 10000);
    assert.equal(await dashboardPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, 'Mobile layout has no horizontal overflow');
    await dashboardPage.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: false });
    await dashboardPage.setViewportSize({ width: 1440, height: 1000 });
    await dashboardPage.locator('[data-view="tasks"]').first().click(); await sleep(300);
    await dashboardPage.screenshot({ path: join(screenshots, 'task-manager.png'), fullPage: true });
    assert.deepEqual(pageErrors, []); assert.deepEqual(failedRequests, []);
    return { desktop: '1440x1000', mobile: '390x844', targetViewport: '1280x720', targetViewportUnchanged: true, targetsRemainDesktop: true, horizontalOverflow: false, pageErrors: 0, failedRequests: 0 };
  });
  await check('full administrator browser UI operates the real profile and returns to the grid', async () => {
    await dashboardPage.locator('[data-view="live"]').first().click();
    await dashboardPage.locator('#full-admin-view').click();
    await dashboardPage.locator('#browser-workspace').waitFor({ state: 'visible' });
    const browserPath = `profiles/${adminId}/browser`, initial = (await api(browserPath)).browser;
    const original = initial.tabs.find(tab => tab.url === fixture.pageUrl); assert.ok(original);
    assert.equal(await dashboardPage.locator('#browser-stage canvas').count(), 1, 'Expanded view retains one real canvas');
    await dashboardPage.locator('#browser-address').fill(`${fixture.pageUrl}/second`);
    await dashboardPage.locator('#browser-go').click();
    await waitFor('address bar drives actual administrator browser', () => admin.page.url() === `${fixture.pageUrl}/second`);
    assert.equal((await profileStatus(adminId)).role, 'manual');
    await dashboardPage.locator('[data-browser-action="new-tab"]').click();
    let extra;
    await waitFor('UI creates native isolated tab', async () => {
      extra = (await api(browserPath)).browser.tabs.find(tab => !initial.tabs.some(old => old.id === tab.id)); return !!extra;
    });
    await dashboardPage.locator(`[data-tab-id="${original.id}"]`).click();
    await waitFor('UI selects original native tab', async () => (await api(browserPath)).browser.activeTabId === original.id);
    await dashboardPage.locator(`[data-close-tab-id="${extra.id}"]`).click();
    await waitFor('UI closes only extra native tab', async () => !(await api(browserPath)).browser.tabs.some(tab => tab.id === extra.id));
    await dashboardPage.locator('#browser-address').fill(fixture.pageUrl); await dashboardPage.locator('#browser-go').click();
    await waitFor('UI restores original local page', () => admin.page.url() === fixture.pageUrl);
    await dashboardPage.locator('#browser-address').fill(`${fixture.pageUrl}/stalled`); await dashboardPage.locator('#browser-go').click();
    const uiStop = dashboardPage.locator('[data-browser-action="stop"]');
    await waitFor('native streaming page keeps its UI Stop control available', async () => admin.page.url() === `${fixture.pageUrl}/stalled` && await uiStop.isEnabled(), 10000);
    assert.equal(await dashboardPage.locator('#browser-go').isDisabled(), true, 'Ordinary browser controls remain busy during the pending streaming navigation');
    await uiStop.click();
    await waitFor('UI Stop releases navigation and restores browser controls', async () => {
      const browser = (await api(browserPath)).browser;
      return browser.loading === false && await dashboardPage.locator('#browser-address').isEnabled() && await dashboardPage.locator('#browser-go').isEnabled() && await uiStop.isDisabled();
    }, 10000);
    await dashboardPage.locator('#browser-address').fill(fixture.pageUrl); await dashboardPage.locator('#browser-go').click();
    await waitFor('address bar remains usable after stopping native loading', () => nativeDocumentMatches(admin.page, fixture.pageUrl, 'Local browser acceptance'));
    assert.equal((await api(browserPath)).browser.error, undefined, 'Stopping a pending navigation leaves the browser usable without a stale error');
    await waitFor('full admin canvas receives decoded live image', () => dashboardPage.evaluate(() => document.querySelector('#browser-stage .live-tile')?._frameHealthy === true));
    await dashboardPage.screenshot({ path: join(screenshots, 'full-admin-view.png'), fullPage: false });
    await dashboardPage.setViewportSize({ width: 390, height: 844 });
    assert.equal(await dashboardPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, 'Full browser controls fit mobile viewport');
    await dashboardPage.screenshot({ path: join(screenshots, 'mobile-browser.png'), fullPage: false });
    await dashboardPage.setViewportSize({ width: 1440, height: 1000 });
    await dashboardPage.locator('#browser-return-grid').click();
    await dashboardPage.locator('#browser-workspace').waitFor({ state: 'hidden' });
    assert.equal(await dashboardPage.locator('.live-tile').count(), 3);
    await dashboardPage.locator(`[data-action="browser"][data-profile-id="${firefoxId}"]`).first().click();
    await dashboardPage.locator('#browser-workspace').waitFor({ state: 'visible' });
    assert.ok(await dashboardPage.locator('#browser-profile-name').textContent().then(value => value.includes('Firefox')));
    await dashboardPage.locator('#browser-take-manual').click();
    await waitFor('follower full view requires explicit manual takeover', async () => (await profileStatus(firefoxId)).role === 'manual');
    await dashboardPage.locator('#browser-return-grid').click();
    await readyRoles(adminId, [followerId, firefoxId]);
    return { realProfileNavigation: true, fullAdminView: true, newSelectCloseTab: true, stopInFlightLoading: true, explicitFollowerTakeover: true, gridRestored: true, mobileOverflow: false };
  });
  await check('live local profile deletion and network mutation are rejected', async () => {
    await api(`profiles/${followerId}`, { confirmation: followerId }, 409, true, 'DELETE');
    await api(`profiles/${followerId}/network`, { networkMode: 'system' }, 409);
    await api(`profiles/${followerId}/screen`, { width: 1473, height: 913 }, 409);
    await assertDesktopDisplay(follower.page, 'chromium', { width: 1280, height: 720 });
    assert.ok(fixture.runtime.workspace.manager.getLaunch(followerId));
    assert.ok(await stat(follower.launch.userDataDir));
    assert.equal(await follower.page.title(), 'Local browser acceptance');
    return { runningDeleteRejected: true, runningNetworkChangeRejected: true, runningScreenChangeRejected: true, liveDirectoryPreserved: true };
  });
  await check('native memory/CPU metrics and actual Chromium heap arguments', async () => {
    await waitFor('verified native resource samples', async () => {
      const rows = (await snapshot()).profiles;
      return [adminId, followerId, firefoxId].every(id => rows.some(row => row.id === id && row.metricsVerified && row.memoryMb > 0 && Number.isFinite(row.cpuPercent) && row.processCount >= 1));
    }, 40000);
    const rows = (await snapshot()).profiles;
    report.resourceMetrics = rows.map(row => ({ engine: row.engine, verified: row.metricsVerified, memoryMb: row.memoryMb, cpuPercent: row.cpuPercent, processCount: row.processCount, budgetMb: row.ramMb, heapMb: row.heapMb }));
    for (const id of [adminId, followerId]) {
      const record = await fixture.nativeRoot(id); const args = record.argv ?? windowsArgv(record.commandLine);
      assert.ok(args.some(arg => arg === '--js-flags=--max-old-space-size=512'), 'Configured V8 limit in actual Windows command line');
      assert.ok(args.includes('--force-device-scale-factor=1'), 'Configured device scale in actual Windows command line');
    }
  });
  await check('paced manual takeover cancels only its Chromium follower and preserves Firefox queued replay', async () => {
    await api('settings', { origins: [fixture.origin], pacing: 'paced' }); await readyRoles(adminId, [followerId, firefoxId]);
    const before = await count(follower.page), firefoxBefore = await count(firefox.page);
    const relay = fixture.runtime.workspace.relay;
    const captureEpoch = relay.configFor(adminId).epoch, firefoxEpoch = relay.configFor(firefoxId).epoch;
    assert.equal(relay.epoch, captureEpoch, 'Public capture epoch belongs to the administrator');
    await admin.page.locator('[data-testid="open-panel"]').click();
    await waitFor('safe action queued for both actual follower engines', async () => {
      const rows = (await snapshot()).profiles;
      return [followerId, firefoxId].every(id => rows.some(row => row.id === id && row.queued > 0));
    });
    await api('manual', { profileId: followerId, enabled: true });
    assert.equal(relay.configFor(adminId).epoch, captureEpoch, 'Follower takeover preserves the administrator capture epoch');
    assert.equal(relay.epoch, captureEpoch, 'Public capture epoch remains the administrator epoch');
    assert.equal(relay.configFor(firefoxId).epoch, firefoxEpoch, 'Unrelated Firefox follower retains its queued action epoch');
    await waitFor('existing paced Firefox action survives Chromium manual takeover', async () => await count(firefox.page) === firefoxBefore + 1, 7000);
    await sleep(2100); assert.equal(await count(follower.page), before, 'No late paced event after manual takeover');
    const manual = await profileStatus(followerId); assert.equal(manual.role, 'manual'); assert.equal(manual.queued, 0);
    const peer = await profileStatus(firefoxId); assert.equal(peer.role, 'follower'); assert.equal(peer.connected, true); assert.equal(peer.queued, 0);
    await api('manual', { profileId: followerId, enabled: false }); await sleep(400);
    assert.equal(await count(follower.page), before, 'Explicit resume does not replay canceled work');
    await admin.page.locator('[data-testid="open-panel"]').click();
    await waitFor('fresh action after explicit resume reaches both follower engines', async () => await count(follower.page) === before + 1 && await count(firefox.page) === firefoxBefore + 2, 7000);
    return { canceledFollower: 'chromium', unaffectedFollower: 'firefox', queuedFirefoxActionDelivered: true, controllerEpochPreserved: true };
  });
  await check('actual profile socket disconnect cancels pending replay and requires resume', async () => {
    await readyRoles(adminId, [followerId, firefoxId]); const before = await count(follower.page);
    await admin.page.locator('[data-testid="open-panel"]').click();
    await waitFor('action queued before transport failure', async () => (await profileStatus(followerId)).queued > 0);
    fixture.disconnectChromiumRelay(followerId);
    await waitFor('transport failure switches profile to manual', async () => (await profileStatus(followerId)).role === 'manual');
    await sleep(2300); assert.equal(await count(follower.page), before, 'Disconnected queued work is discarded');
    await waitFor('actual MV3 socket reconnects', async () => (await profileStatus(followerId)).connected === true, 15000);
    assert.equal((await profileStatus(followerId)).role, 'manual');
    await api('manual', { profileId: followerId, enabled: false }); await sleep(400);
    assert.equal(await count(follower.page), before, 'Reconnect and explicit resume never replay a backlog');
  });
  await check('financial fixture control remains independent manual input', async () => {
    await api('settings', { origins: [fixture.origin], pacing: 'fast' }); await readyRoles(adminId, [followerId, firefoxId]);
    await admin.page.locator('[data-testid="place-bet"]').click();
    await waitFor('sensitive controller action switches to manual', async () => (await profileStatus(adminId)).role === 'manual');
    assert.equal(await follower.page.locator('[data-testid="financial-counter"]').textContent(), '0');
    assert.equal(await firefox.page.locator('[data-testid="financial-counter"]').textContent(), '0');
    return { operation: 'Local fixture only; no wagering implementation or account', mirrored: false };
  });
  await check('owned force-close preserves unrelated browser profiles', async () => {
    await api('kill', { profileId: followerId });
    assert.equal(fixture.runtime.workspace.manager.getLaunch(followerId), null);
    assert.ok(fixture.runtime.workspace.manager.getLaunch(adminId)); assert.ok(fixture.runtime.workspace.manager.getLaunch(firefoxId));
    assert.equal(await count(admin.page) >= 1, true); assert.equal(await count(firefox.page) >= 1, true);
  });
  await check('typed local profile deletion removes only stopped owned data', async () => {
    const path = `profiles/${followerId}`;
    await api(path, { confirmation: 'incorrect-confirmation' }, 400, true, 'DELETE');
    assert.ok(fixture.runtime.store.getProfile(followerId)); assert.ok(await stat(follower.launch.userDataDir));
    await dashboardPage.locator('[data-view="live"]').first().click();
    await dashboardPage.locator(`[data-action="settings"][data-profile-id="${followerId}"]`).first().click();
    await dashboardPage.locator('#profile-settings-dialog').waitFor({ state: 'visible' });
    await dashboardPage.locator('#profile-delete-button').click();
    await dashboardPage.locator('#delete-dialog').waitFor({ state: 'visible' });
    await dashboardPage.locator('#delete-form [name="confirmation"]').fill('incorrect-confirmation');
    assert.equal(await dashboardPage.locator('#delete-submit').isDisabled(), true);
    await dashboardPage.locator('#delete-form [name="confirmation"]').fill(followerId);
    await dashboardPage.locator('#delete-submit').click();
    await dashboardPage.locator('#delete-dialog').waitFor({ state: 'hidden' });
    await waitFor('stopped local profile metadata is deleted', async () => !(await snapshot()).profiles.some(row => row.id === followerId));
    assert.equal(fixture.runtime.store.getProfile(followerId), null);
    await assert.rejects(stat(follower.launch.userDataDir), { code: 'ENOENT' });
    await api(`${path}/browser`, undefined, 404);
    assert.equal(fixture.runtime.workspace.relay.configFor(followerId), undefined);
    const library = await api('library');
    assert.equal(library.profiles.some(row => row.profileId === followerId), false, 'Deleted profile organization metadata is removed');
    for (const id of [adminId, firefoxId]) {
      const metadata = (await api(`library/profiles/${id}`)).metadata;
      assert.equal(metadata.groupId, libraryGroupId); assert.deepEqual(metadata.tags, ['fixture', 'preview2']);
      assert.deepEqual(metadata.bookmarks, [{ title: 'Local safe fixture', url: fixture.pageUrl }]);
    }
    assert.equal(admin.page.isClosed(), false); assert.equal(firefox.page.isClosed(), false);
    assert.ok(fixture.runtime.workspace.manager.getLaunch(adminId)); assert.ok(fixture.runtime.workspace.manager.getLaunch(firefoxId));
    return { exactTypedId: true, stoppedOwnedDirectoryRemoved: true, metadataAndRelayRemoved: true, unrelatedProfilesSurvive: true, websiteAccountsAffected: false };
  });
  await check('native local Chromium and Firefox add-ons enforce reviewed host scope and disable on restart', async () => {
    const files = fixture.createAddonFixtures(), results = [];
    for (const [engine, packagePath, marker] of [['chromium', files.chromiumDirectory, 'chromium-preview2'], ['firefox', files.firefoxXpi, 'firefox-preview2']]) {
      await checkpoint('addons.import', { engine });
      const imported = (await api('extensions/import', { path: packagePath, engine })).extension;
      assert.ok(imported?.id); assert.match(imported.sha256, /^[a-f0-9]{64}$/);
      await checkpoint('addons.create-profile', { engine });
      const row = (await api('bulk', { count: 1, prefix: `Acceptance ${engine} addon`, engine, urls: [fixture.pageUrl], origin: fixture.origin,
        networkMode: 'direct', ramMb: 4096, heapMb: 512, resolutions: ['1280x720'], headless: true })).profiles[0];
      await checkpoint('addons.custom-desktop-screen', { engine, profileId: row.id });
      await dashboardPage.locator('[data-view="live"]').first().click();
      await dashboardPage.locator(`[data-action="settings"][data-profile-id="${row.id}"]`).first().click();
      const screenForm = dashboardPage.locator('#profile-screen-form');
      await screenForm.locator('[name="screenPreset"]').selectOption('custom');
      await screenForm.locator('[name="width"]').fill('1473'); await screenForm.locator('[name="height"]').fill('913');
      await dashboardPage.locator('#screen-save').click();
      await waitFor(`${engine} stopped profile saves its exact custom desktop screen`, async () => {
        const saved = await profileStatus(row.id); return saved.screenWidth === 1473 && saved.screenHeight === 913;
      });
      assert.equal(fixture.runtime.store.getProfile(row.id).screenWidth, 1473); assert.equal(fixture.runtime.store.getProfile(row.id).screenHeight, 913);
      await dashboardPage.locator('#profile-settings-dialog [data-close="profile-settings-dialog"]').first().click();
      if (engine === 'chromium') {
        await checkpoint('addons.network-settings', { engine, profileId: row.id });
        const saved = await api('proxies', { alias: 'Acceptance saved local route', group: 'fixture', proxy: { type: 'http', host: '127.0.0.1', port: '9', user: 'fixture-proxy-user', pass: 'fixture-proxy-secret' } }, 201);
        assert.equal(saved.proxy.authenticated, true); assert.equal(JSON.stringify(saved).includes('fixture-proxy-secret'), false); assert.equal(JSON.stringify(saved).includes('fixture-proxy-user'), false);
        const assignedProxy = await api(`proxies/${saved.proxy.id}/assign`, { profileIds: [row.id] });
        assert.equal(assignedProxy.results[0].success, true); assert.equal((await profileStatus(row.id)).networkMode, 'proxy');
        await api(`proxies/${saved.proxy.id}`, undefined, 200, true, 'DELETE');
        assert.equal((await profileStatus(row.id)).networkMode, 'proxy', 'Registry removal preserves the independent saved profile endpoint');
        await dashboardPage.locator('[data-view="live"]').first().click();
        await dashboardPage.locator(`[data-action="settings"][data-profile-id="${row.id}"]`).first().click();
        const networkForm = dashboardPage.locator('#profile-settings-form');
        await networkForm.locator('[name="networkMode"]').selectOption('system');
        await dashboardPage.locator('#network-save').click();
        await waitFor('profile settings saves system route', async () => (await profileStatus(row.id)).networkMode === 'system');
        await networkForm.locator('[name="networkMode"]').selectOption('direct');
        await dashboardPage.locator('#network-save').click();
        await waitFor('profile settings saves direct route', async () => (await profileStatus(row.id)).networkMode === 'direct');
        await dashboardPage.locator('#profile-settings-dialog [data-close="profile-settings-dialog"]').first().click();
      }
      const path = `profiles/${row.id}/extensions`;
      const request = { extensionId: imported.id, enabled: true, siteAccess: 'sites', origins: [fixture.origin], reviewedSha256: imported.sha256 };
      await checkpoint('addons.review-permissions', { engine, profileId: row.id });
      await api(path, { ...request, reviewedSha256: '0'.repeat(64) }, 400);
      await dashboardPage.locator('[data-view="extensions"]').first().click();
      await dashboardPage.locator(`[data-extension-review="${imported.id}"]`).waitFor({ state: 'visible' });
      await dashboardPage.locator(`[data-extension-review="${imported.id}"]`).click();
      const review = dashboardPage.locator('#extension-assignment-form');
      await review.locator('[name="profileId"]').selectOption(row.id);
      await review.locator('[name="siteAccess"]').selectOption('sites');
      await review.locator('[name="origins"]').fill(fixture.origin);
      await review.locator('[name="reviewed"]').check();
      assert.ok(await dashboardPage.locator('#extension-review-details').textContent().then(value => value.includes(imported.sha256)), 'Native UI shows the reviewed immutable digest');
      if (engine === 'chromium') await dashboardPage.screenshot({ path: join(screenshots, 'extension-permissions.png'), fullPage: false });
      await dashboardPage.locator('#extension-assignment-submit').click();
      await dashboardPage.locator('#extension-review-dialog').waitFor({ state: 'hidden' });
      const assigned = (await api(path)).assignments.find(item => item.extensionId === imported.id);
      assert.equal(assigned?.enabled, true, 'Explicit UI permission review enables only the selected stopped profile');
      await checkpoint('addons.start-enabled-profile', { engine, profileId: row.id });
      await api('start', { profileId: row.id });
      await checkpoint('addons.connect-enabled-profile', { engine, profileId: row.id });
      const attached = await fixture.connectProfile(row.id, playwright); inspectors.push(attached);
      const customDisplay = await assertDesktopDisplay(attached.page, engine, { width: 1473, height: 913 }, true);
      await api(`profiles/${row.id}/screen`, { width: 1600, height: 1000 }, 409);
      if (engine === 'chromium') {
        const native = await fixture.nativeRoot(row.id), args = native.argv ?? windowsArgv(native.commandLine);
        assert.ok(args.includes('--no-proxy-server')); assert.equal(Boolean(attached.launch.relayPort), false, 'Direct launch ignores the saved authenticated endpoint');
      }
      await checkpoint('addons.verify-enabled-marker', { engine, profileId: row.id });
      await waitFor(`${engine} native add-on executes on reviewed host`, () => attached.page.evaluate(() => document.documentElement.dataset.stakemodeAddon).then(value => value === marker));
      await api('manual', { profileId: row.id, enabled: true });
      const originalTab = (await api(`profiles/${row.id}/browser`)).browser.tabs.find(tab => tab.url === fixture.pageUrl); assert.ok(originalTab);
      for (const kind of ['popup', 'options']) {
        await checkpoint(`addons.open-${kind}`, { engine, profileId: row.id });
        const uiDiagnostic = { engine, kind };
        (report.addonUiDiagnostics ??= []).push(uiDiagnostic);
        const openResult = await api(`${path}/${imported.id}/open`, { kind });
        uiDiagnostic.openResponse = browserDiagnostics(openResult.browser, fixture.pageUrl);
        let opened;
        try {
          await waitFor(`${engine} native ${kind} page is installed and readable`, async () => {
            const state = (await api(`profiles/${row.id}/browser`)).browser;
            uiDiagnostic.lastState = browserDiagnostics(state, fixture.pageUrl);
            opened = state.tabs.find(tab => tab.title === `StakeMode ${engine} ${kind} fixture`); return !!opened;
          }, 20000);
        } catch (error) {
          // This profile contains only fresh, owned local acceptance fixtures.
          // Keep public fixture markers and URL classifications, never full URLs.
          uiDiagnostic.nativePages = await Promise.all(attached.context.pages().slice(0, 6).map(async page => {
            try { return await boundedObservation('local add-on UI failure', () => page.evaluate(() => ({
              scheme: location.protocol, extensionPath: /^(?:moz|chrome)-extension:$/.test(location.protocol) ? location.pathname : null,
              netError: document.documentURI.startsWith('about:neterror'), title: document.title.slice(0, 160),
              marker: document.querySelector('[data-testid="extension-ui"]')?.textContent?.slice(0, 160) ?? null,
              errorCode: document.querySelector('#errorCode')?.textContent?.slice(0, 80) ?? null,
            })), 2500); } catch { return { unavailable: true }; }
          }));
          throw error;
        }
        const nativePage = attached.context.pages().find(page => page.url() === opened.url); assert.ok(nativePage);
        assert.ok(opened.url.startsWith(engine === 'firefox' ? 'moz-extension://' : 'chrome-extension://'));
        await assertDesktopDisplay(nativePage, engine, { width: 1473, height: 913 }, true);
        assert.equal(await boundedObservation(`${engine} actual ${kind} package content`, () => nativePage.locator('[data-testid="extension-ui"]').textContent()), `${marker}:${kind}`, 'Opened page is actual trusted package HTML');
        socket.send(JSON.stringify({ type: 'SUBSCRIBE', profileIds: [adminId, firefoxId, row.id] }));
        socket.send(JSON.stringify({ type: 'FOCUS', profileId: row.id }));
        const input = nativePage.locator('[data-testid="extension-filter"]'), button = nativePage.locator('[data-testid="extension-button"]');
        const inputBox = await input.boundingBox(), buttonBox = await button.boundingBox(); assert.ok(inputBox && buttonBox);
        socket.send(JSON.stringify({ type: 'CONTROL', profileId: row.id, kind: 'click', x: inputBox.x + inputBox.width / 2, y: inputBox.y + inputBox.height / 2 }));
        await waitFor(`${engine} ${kind} direct input focus`, () => input.evaluate(node => node === document.activeElement));
        socket.send(JSON.stringify({ type: 'CONTROL', profileId: row.id, kind: 'text', text: `public ${kind} filter` }));
        await waitFor(`${engine} ${kind} direct text input`, async () => await input.inputValue() === `public ${kind} filter`);
        socket.send(JSON.stringify({ type: 'CONTROL', profileId: row.id, kind: 'click', x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 }));
        await waitFor(`${engine} ${kind} direct button input`, async () => await nativePage.locator('[data-testid="extension-count"]').textContent() === '1');
        uiDiagnostic.nativeManualTextAndClick = true;
        await checkpoint(`addons.close-${kind}`, { engine, profileId: row.id });
        await api(`profiles/${row.id}/browser`, { action: 'close-tab', tabId: opened.id });
        await api(`profiles/${row.id}/browser`, { action: 'select-tab', tabId: originalTab.id });
        assert.equal(attached.page.isClosed(), false);
      }
      await api(path, { ...request, enabled: false }, 409);
      await api('manual', { profileId: row.id, enabled: true });
      await checkpoint('addons.verify-denied-host', { engine, profileId: row.id });
      await api(`profiles/${row.id}/browser`, { action: 'navigate', url: files.deniedUrl });
      await waitFor(`${engine} native denied host loaded`, () => attached.page.url() === files.deniedUrl);
      assert.equal(await boundedObservation(`${engine} denied-host add-on marker`, () => attached.page.evaluate(() => document.documentElement.dataset.stakemodeAddon)), undefined, 'Unapproved host receives no add-on content script');
      await checkpoint('addons.detach-enabled-inspector', { engine, profileId: row.id });
      await disconnectInspector(attached.browser);
      await checkpoint('addons.stop-enabled-profile', { engine, profileId: row.id });
      await api('stop', { profileId: row.id });
      await checkpoint('addons.disable-assignment', { engine, profileId: row.id });
      await api(path, { ...request, enabled: false });
      await checkpoint('addons.restart-disabled-profile', { engine, profileId: row.id });
      await api('start', { profileId: row.id });
      await checkpoint('addons.connect-disabled-profile', { engine, profileId: row.id });
      const disabled = await fixture.connectProfile(row.id, playwright); inspectors.push(disabled);
      await assertDesktopDisplay(disabled.page, engine, { width: 1473, height: 913 }, true);
      await checkpoint('addons.verify-disabled-marker', { engine, profileId: row.id });
      assert.equal(await boundedObservation(`${engine} disabled add-on marker`, () => disabled.page.evaluate(() => document.documentElement.dataset.stakemodeAddon)), undefined, 'Disabled add-on is absent after the same persistent profile restarts');
      await disabled.page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(await boundedObservation(`${engine} disabled add-on marker after reload`, () => disabled.page.evaluate(() => document.documentElement.dataset.stakemodeAddon)), undefined, 'Reload does not reactivate a persisted add-on');
      const libraryEntry = (await api('extensions')).extensions.find(item => item.id === imported.id);
      assert.equal(libraryEntry.sha256, imported.sha256, 'Profile host-scope copies preserve immutable library digest');
      await checkpoint('addons.detach-disabled-inspector', { engine, profileId: row.id });
      await disconnectInspector(disabled.browser);
      await checkpoint('addons.stop-disabled-profile', { engine, profileId: row.id });
      await api('stop', { profileId: row.id });
      await checkpoint('addons.delete-fixture-profile', { engine, profileId: row.id });
      await api(`${path}/${imported.id}`, undefined, 200, true, 'DELETE');
      await api(`extensions/${imported.id}`, undefined, 200, true, 'DELETE');
      await api(`profiles/${row.id}`, { confirmation: row.id }, 200, true, 'DELETE');
      results.push({ engine, customDisplay, customScreenSavedThroughUi: true, runningScreenChangeRejected: true, popupAndOptionsRetainCustomViewport: true,
        reviewedDigestRequired: true, nativeMarker: true, nativePopupAndOptions: true, allowedHost: '127.0.0.1', deniedHost: 'localhost', hostScopeEnforced: true, disabledAfterRestart: true, immutableImport: true });
      await checkpoint('addons.engine-complete', { engine, profileId: row.id });
    }
    assert.equal(admin.page.isClosed(), false); assert.equal(firefox.page.isClosed(), false);
    return results;
  });
  await check('confirmed graceful closure of every owned remaining profile', async () => {
    for (const item of inspectors) await disconnectInspector(item.browser);
    socket.close(); await fixture.closeDashboard(); dashboardBrowser = undefined; dashboardContext = undefined;
    await fixture.close(); // Runtime and final native process snapshot confirm owned cleanup.
    fixture = undefined;
  });
  await check('actual independent native browser proxy routing with local reserved-host fixtures', async () => {
    report.proxyAcceptance = await runProxyAcceptance({ ...proxyOptions, checkBudget: budget });
    budget();
    assert.equal(report.proxyAcceptance.independentRouting, true);
    assert.equal(report.proxyAcceptance.http.authenticated, true);
    assert.equal(report.proxyAcceptance.socks5.authenticated, true);
    assert.equal(report.proxyAcceptance.socks5.remoteDns, true);
    assert.equal(report.proxyAcceptance.wrongCredentials.http, true);
    assert.equal(report.proxyAcceptance.wrongCredentials.socks5, true);
    assert.equal(report.proxyAcceptance.separateProfileDirectories, true);
    assert.equal(report.proxyAcceptance.separateRelayPorts, true);
    assert.equal(report.proxyAcceptance.confirmedNativeCleanup, true);
    assert.deepEqual(report.proxyAcceptance.networkModes.direct, { savedProxyIgnored: true, noProxyArgument: true, loopbackPageLoaded: true });
    assert.deepEqual(report.proxyAcceptance.networkModes.system, { savedProxyIgnored: true, browserProxyOverrideAbsent: true, loopbackPageLoaded: true });
    assert.deepEqual(report.proxyAcceptance.networkModes.firefoxPrefs, { direct: 0, system: 5, loopbackPageLoaded: true });
    return report.proxyAcceptance;
  });
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); console.error(report.error);
  report.nativeProcessDiagnostics = { host: readHostProcessSnapshotDiagnostics(), resources: readResourceSnapshotDiagnostics() };
  report.firefoxOwnerDiagnostics = getFirefoxOwnerDiagnostics();
  await checkpoint('failure.capture-diagnostics');
  if (dashboardPage) {
    report.dashboardDiagnostics = await boundedObservation('failure dashboard state', () => dashboardPage.evaluate(() => ({
      hidden: document.hidden, visibility: document.visibilityState,
      innerWidth, innerHeight, scrollX, scrollY,
      tiles: [...document.querySelectorAll('.live-tile')].slice(0, 12).map(tile => {
        const bounds = tile.getBoundingClientRect(), canvas = tile.querySelector('canvas'), overlay = tile.querySelector('.stream-message');
        return { profileId: tile.dataset.profileId, visible: tile._visible ?? null, frameHealthy: tile._frameHealthy ?? null,
          frameAt: tile._frameAt ?? null, frameSequence: tile._frameSequence ?? null,
          canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
          overlayHidden: overlay?.hidden ?? null, overlayText: overlay?.textContent?.trim().slice(0, 240) ?? null,
          bounds: { top: bounds.top, left: bounds.left, bottom: bounds.bottom, right: bounds.right, width: bounds.width, height: bounds.height } };
      }),
    })), 2000).catch(() => ({ unavailable: true }));
    await boundedObservation('failure dashboard screenshot', () => dashboardPage.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true, timeout: 3000 }), 4000).catch(() => {});
  }
} finally {
  clearTimeout(watchdog);
  const checksPassed = report.passed;
  report.passed = false;
  await checkpoint('cleanup.begin');
  socket?.close();
  for (const [index, item] of inspectors.entries()) {
    await checkpoint('cleanup.detach-inspector', { index, engine: item.launch.engine });
    await disconnectInspector(item.browser);
  }
  await checkpoint('cleanup.detach-dashboard');
  await disconnectInspector(dashboardBrowser); // The fixture owns and verifies the QA browser lifecycle.
  if (fixture) {
    await checkpoint('cleanup.close-owned-runtime');
    try { await fixture.close(); report.cleanupConfirmed = true; }
    catch (error) { report.cleanupConfirmed = false; report.cleanupError = error instanceof Error ? error.message : String(error); report.passed = false; }
  } else report.cleanupConfirmed = true;
  report.passed = checksPassed && report.cleanupConfirmed && !report.checkpointWriteFailed;
  report.finishedAt = new Date().toISOString(); report.pageErrors = pageErrors; report.failedRequests = failedRequests;
  report.nativeProcessDiagnostics = { host: readHostProcessSnapshotDiagnostics(), resources: readResourceSnapshotDiagnostics() };
  report.firefoxOwnerDiagnostics = getFirefoxOwnerDiagnostics();
  report.serverFrames = [...latestFrameGeometry.values()];
  report.frameErrors = frameErrors.slice(-20);
  await checkpoint('cleanup.complete');
  if (report.checkpointWriteFailed) report.passed = false;
  await persistReport();
}
// Failed ownership verification can intentionally leave the runtime open. The
// failed report above is fully persisted, including cleanupConfirmed:false;
// finish this CI harness without weakening production shutdown or killing by name.
if (!report.passed) process.exit(1);
