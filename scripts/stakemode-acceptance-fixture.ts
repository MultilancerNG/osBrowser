/** Local acceptance fixture: no third-party pages, credentials or wagering. */
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Launcher } from '../launcher.ts';
import { ProfileStore } from '../store.ts';
import { buildNewProfile } from '../create.ts';
import type { Browser } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startStakeMode } from '../StakeMode-cli.ts';
import { callFirefoxOwner } from '../firefox-runtime.ts';
import { ownedRoot, readResourceSnapshot } from '../workspace/resourceMonitor.ts';

/** Standard uncompressed ZIP writer for the small, harmless Firefox XPI fixture. */
function fixtureZip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const [filename, value] of Object.entries(files)) {
    const name = Buffer.from(filename), bytes = Buffer.from(value), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(entry, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Local browser acceptance</title>
<style>body{margin:0;background:#17222e;color:#edf2f7;font:20px system-ui}main{padding:36px}button,input{font:inherit;padding:16px;border-radius:8px}button{background:#edba61;color:#101214;border:0}input{background:#fff;color:#121212;border:2px solid #888}section{margin-top:24px}#spacer{height:2100px;background:linear-gradient(#17222e,#34536d)}footer{padding:30px;background:#10202b}</style></head><body><main>
<h1>Independent browser fixture</h1><p>No external website or account is involved.</p>
<button type="button" data-testid="open-panel">Open panel</button><p>Panels opened: <output data-testid="counter">0</output></p>
<label for="filter">Filter panels</label> <input id="filter" name="filter" type="text" placeholder="Filter panels" data-testid="filter"><p>Current filter: <output data-testid="filter-result"></output></p>
<section><button type="button" data-testid="place-bet">Place bet</button><p>This button changes only a local fixture counter: <output data-testid="financial-counter">0</output>. It has no financial operation.</p></section>
<p data-testid="last-trust">No input yet</p><div id="spacer"></div></main><footer>Scroll verification footer</footer>
<script>window.fixtureState={count:0,financial:0,lastTrusted:null};const out=document.querySelector('[data-testid="counter"]');document.querySelector('[data-testid="open-panel"]').addEventListener('click',e=>{window.fixtureState.count++;window.fixtureState.lastTrusted=e.isTrusted;out.textContent=String(window.fixtureState.count);document.querySelector('[data-testid="last-trust"]').textContent=e.isTrusted?'Trusted operator input':'Synthetic follower input'});document.querySelector('[name="filter"]').addEventListener('input',e=>{document.querySelector('[data-testid="filter-result"]').textContent=e.target.value});document.querySelector('[data-testid="place-bet"]').addEventListener('click',()=>{document.querySelector('[data-testid="financial-counter"]').textContent=String(++window.fixtureState.financial)});</script>
</body></html>`;

export async function startAcceptanceFixture() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Packaged StakeMode acceptance requires Windows x64');
  const repo = resolve(import.meta.dir, '..');
  const metadata = JSON.parse(readFileSync(join(repo, 'src-tauri', 'generated', 'browser.json'), 'utf8'));
  for (const hash of [metadata.sha256, metadata.firefox?.sha256]) if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('Prepared browser hashes are invalid');
  const patch = metadata.firefox?.extensionUiPatch;
  if (patch?.patchId !== 'stakemode-firefox-extension-ui-v1' || patch.sourceCommit !== '013ebace6cc69c1979c7a86636139e91face6419'
    || !Array.isArray(patch.archives) || patch.archives.length < 1 || patch.archives.length > 8) throw new Error('Prepared Firefox add-on UI provenance is missing');
  for (const archive of patch.archives) {
    if (typeof archive.path !== 'string' || archive.path.includes('\\') || archive.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || !/^(?:[a-zA-Z0-9_.-]+\/)*(?:omni\.ja|juggler\.jar)$/.test(archive.path)
      || !/^[a-f0-9]{64}$/.test(archive.afterSha256)) throw new Error('Prepared Firefox add-on UI archive identity is invalid');
    const actual = createHash('sha256').update(readFileSync(join(resolve('src-tauri/resources/firefox'), archive.path))).digest('hex');
    if (actual !== archive.afterSha256) throw new Error('Prepared Firefox add-on UI archive differs from its recorded patch');
  }
  if (!process.env.ALIASMODE_PLAYWRIGHT_RUNTIME) throw new Error('Packaged Playwright runtime must be selected explicitly');
  const root = mkdtempSync(join(tmpdir(), 'stakemode-acceptance-'));
  const requestHistory: Array<{ at: number; path: string; probe: boolean; hasQuery: boolean; kind: string }> = [];
  const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const url = new URL(request.url);
    const known = ['/fixture', '/fixture/second', '/fixture/stalled'].includes(url.pathname);
    requestHistory.push({ at: Date.now(), path: known ? url.pathname : '[other]', probe: request.headers.get('X-StakeMode-Fixture-Probe') === '1', hasQuery: !!url.search, kind: url.pathname === '/fixture/stalled' ? 'stream' : known ? 'complete' : 'not-found' });
    if (requestHistory.length > 60) requestHistory.shift();
    if (url.pathname === '/fixture/stalled') return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('<!doctype html><html><head><title>Stalled local fixture</title></head><body><h1>Bounded stop-loading fixture</h1>')); },
      cancel() { /* Native stop-loading aborts this local stream; no timer or remote request exists. */ },
    }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' } });
    // Each fixture document uses its own HTTP connection. This keeps native
    // navigation proof independent of Bun/Windows idle keep-alive reuse.
    if (['/fixture', '/fixture/second'].includes(url.pathname)) return new Response(url.pathname.endsWith('/second') ? page.replace('<title>Local browser acceptance</title>', '<title>Second local fixture</title>') : page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' } });
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store', connection: 'close' } });
  }});
  const origin = `http://127.0.0.1:${fixture.port}`;
  const chromiumPath = join(repo, 'src-tauri', 'resources', 'cloakbrowser', metadata.executable);
  const firefoxPath = join(repo, 'src-tauri', 'resources', 'firefox', metadata.firefox.executable);
  let runtime: Awaited<ReturnType<typeof startStakeMode>>;
  try { runtime = await startStakeMode({ stateRoot: root, binaryPath: chromiumPath, binarySha256: metadata.sha256,
    firefoxBinaryPath: firefoxPath, firefoxBinarySha256: metadata.firefox.sha256 }); }
  catch (error) { fixture.stop(true); throw error; }
  let closing: Promise<void> | undefined;
  let dashboardStore: ProfileStore | undefined, dashboardLauncher: Launcher | undefined;
  let dashboardProfileId: string | undefined, dashboardBrowser: Browser | undefined;
  let dashboardOpening: Promise<{ browser: any; context: any; page: any }> | undefined;
  let dashboardClosing: Promise<void> | undefined;
  const disconnectDashboard = async () => { await dashboardBrowser?.close().catch(() => {}); };
  const closeDashboard = () => dashboardClosing ??= (async () => {
    if (dashboardOpening) await dashboardOpening.catch(() => {});
    await disconnectDashboard();
    if (!dashboardStore) return;
    const launch = dashboardProfileId ? dashboardStore.getLaunch(dashboardProfileId) : null;
    if (dashboardProfileId && dashboardLauncher && !await dashboardLauncher.stop(dashboardProfileId)) throw new Error('QA dashboard browser shutdown could not be confirmed');
    if (dashboardStore.listLaunches().length) throw new Error('QA dashboard launch record survived cleanup');
    if (launch) {
      const records = await readResourceSnapshot();
      if (!records) throw new Error('QA dashboard final native process snapshot is unavailable');
      if (records.some(record => record.pid === launch.pid)) throw new Error('QA dashboard native root PID is still present after cleanup');
    }
    dashboardStore.close();
  })();
  return {
    runtime, origin, pageUrl: `${origin}/fixture`, root, metadata, chromiumPath, firefoxPath,
    requestDiagnostics() { return requestHistory.map(entry => ({ ...entry })); },
    createAddonFixtures() {
      const directory = join(root, 'addon-fixtures'); mkdirSync(directory, { recursive: true, mode: 0o700 });
      const chromiumDirectory = join(directory, 'chromium-marker'); mkdirSync(chromiumDirectory, { recursive: true, mode: 0o700 });
      const matches = ['http://127.0.0.1/*', 'http://localhost/*'];
      const content = { matches, js: ['marker.js'], run_at: 'document_end' };
      const ui = (engine: string, kind: string) => `<!doctype html><html><head><meta charset="utf-8"><title>StakeMode ${engine} ${kind} fixture</title></head><body><h1 data-testid="extension-ui">${engine}-preview2:${kind}</h1><label>Filter local package <input name="filter" data-testid="extension-filter"></label><button type="button" data-testid="extension-button">Open local panel</button><output data-testid="extension-count">0</output><script src="ui.js"></script></body></html>`;
      const uiScript = 'document.querySelector("[data-testid=extension-button]").addEventListener("click",()=>{const output=document.querySelector("[data-testid=extension-count]");output.textContent=String(Number(output.textContent)+1)});';
      const chromiumManifest = { manifest_version: 3, name: 'StakeMode local marker fixture', version: '1.0.0', host_permissions: matches, content_scripts: [content], action: { default_popup: 'popup.html' }, options_ui: { page: 'options.html', open_in_tab: true } };
      writeFileSync(join(chromiumDirectory, 'manifest.json'), JSON.stringify(chromiumManifest), { mode: 0o600 });
      for (const kind of ['popup', 'options']) writeFileSync(join(chromiumDirectory, kind + '.html'), ui('chromium', kind), { mode: 0o600 });
      writeFileSync(join(chromiumDirectory, 'ui.js'), uiScript, { mode: 0o600 });
      writeFileSync(join(chromiumDirectory, 'marker.js'), 'document.documentElement.dataset.stakemodeAddon="chromium-preview2";\n', { mode: 0o600 });
      const firefoxManifest = { manifest_version: 2, name: 'StakeMode local marker fixture', version: '1.0.0',
        browser_specific_settings: { gecko: { id: 'fixture@stakemode.local' } }, permissions: matches, content_scripts: [content], browser_action: { default_popup: 'popup.html' }, options_ui: { page: 'options.html', open_in_tab: true } };
      const firefoxXpi = join(directory, 'firefox-marker.xpi');
      writeFileSync(firefoxXpi, fixtureZip({ 'manifest.json': JSON.stringify(firefoxManifest), 'marker.js': 'document.documentElement.dataset.stakemodeAddon="firefox-preview2";\n', 'popup.html': ui('firefox', 'popup'), 'options.html': ui('firefox', 'options'), 'ui.js': uiScript }), { mode: 0o600 });
      return { chromiumDirectory, firefoxXpi, allowedUrl: `${origin}/fixture`, deniedUrl: `http://localhost:${fixture.port}/fixture` };
    },
    openDashboard(playwright: any) {
      if (dashboardClosing) throw new Error('QA dashboard fixture has already been closed');
      return dashboardOpening ??= (async () => {
        // Use the same certified process/Node-worker path as production profiles.
        // Its private store is outside the workspace manager, so the live grid remains three profiles.
        const dashboardRoot = join(root, 'qa-dashboard');
        mkdirSync(dashboardRoot, { recursive: true, mode: 0o700 });
        dashboardStore = new ProfileStore(join(dashboardRoot, 'profiles.sqlite'));
        dashboardLauncher = new Launcher({ store: dashboardStore, dataRoot: join(dashboardRoot, 'profiles'),
          binaryPath: chromiumPath, expectedBinarySha256: metadata.sha256, headless: true,
          portRange: { start: 19300, end: 19399 }, cdpReadyTimeoutMs: 60000, gracefulStopMs: 5000,
          labelWindow: async () => {},
          baseArgs: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--metrics-recording-only'],
        });
        const profile = buildNewProfile({ engine: 'chromium', name: 'StakeMode dashboard QA', screen: '1440x1000' }, id => !!dashboardStore!.getProfile(id));
        dashboardProfileId = profile.id; dashboardStore.upsertProfile(profile);
        const opened = await dashboardLauncher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLastSession: false });
        const launch = dashboardStore.getLaunch(profile.id);
        if (!launch || launch.headless !== true) throw new Error('QA dashboard has no certified headless launch');
        dashboardBrowser = await playwright.chromium.connectOverCDP(opened.ws, { timeout: 20000 });
        const context = dashboardBrowser!.contexts()[0];
        if (!context) throw new Error('QA dashboard persistent context is unavailable');
        const target = context.pages().find(item => !item.isClosed()) ?? await context.newPage();
        await target.setViewportSize({ width: 1440, height: 1000 });
        return { browser: dashboardBrowser, context, page: target };
      })();
    },
    closeDashboard,
    async connectProfile(profileId: string, playwright: any) {
      const launch = runtime.workspace.manager.getLaunch(profileId);
      if (!launch) throw new Error('Acceptance profile is not running');
      const browser = launch.engine === 'firefox'
        ? await playwright.firefox.connect((await callFirefoxOwner<{ endpoint: string }>(launch.firefoxOwner!, 'playwright-endpoint', {}, { timeoutMs: 15000 })).endpoint, { timeout: 20000 })
        : await playwright.chromium.connectOverCDP(launch.ws, { timeout: 20000 });
      const context = browser.contexts()[0];
      if (!context) throw new Error('Acceptance profile context is missing');
      const target = context.pages().findLast((item: any) => item.url() === `${origin}/fixture`);
      if (!target) throw new Error('Acceptance profile did not open its approved fixture');
      return { browser, context, page: target, launch };
    },
    async nativeRoot(profileId: string) {
      const launch = runtime.workspace.manager.getLaunch(profileId);
      const records = await readResourceSnapshot();
      if (!launch || !records) throw new Error('Native process snapshot is unavailable');
      const record = ownedRoot(launch, records, true);
      if (!record) throw new Error('Native process ownership could not be verified');
      return record;
    },
    disconnectChromiumRelay(profileId: string) {
      // Intentional transport failure injection confined to this imported fixture.
      // The production endpoint exposes no transport or token-management API.
      const row = (runtime.workspace.relay as any).profiles.get(profileId);
      if (!row?.transport) throw new Error('Profile synchronization transport is not connected');
      row.transport.close(1001, 'Acceptance disconnect');
    },
    close() { return closing ??= (async () => {
      const launches = runtime.store.listLaunches();
      try {
        // Workspace shutdown drains the shared native collector. Finish the QA
        // dashboard's own absence check before that drain can cancel its scan.
        // Retain both cleanup attempts even when the first one fails.
        const dashboardClosed = await Promise.allSettled([closeDashboard()]);
        const runtimeClosed = await Promise.allSettled([runtime.close()]);
        const closed = [...dashboardClosed, ...runtimeClosed];
        const failed = closed.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        const records = await readResourceSnapshot();
        if (!records) throw new Error("Final native process snapshot is unavailable");
        if (launches.some(launch => records.some(record => record.pid === launch.pid))) throw new Error("An acceptance browser root PID is still present after graceful cleanup");
      } finally { fixture.stop(true); }
    })(); },
  };
}
