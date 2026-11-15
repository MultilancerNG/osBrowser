import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_CHECKS, INSTALLED_CHECK, MAX_REPORT_BYTES, mergeAcceptance, mergeAcceptanceFiles } from './merge-stakemode-acceptance.mjs';

const SOURCE = 'a'.repeat(40), VERSION = '0.1.0-preview.5';
const hash = (character: string) => character.repeat(64);
function fixtures(): { browser: any; installed: any } {
  const identity = { product: 'StakeMode', version: VERSION, source: SOURCE, platform: 'win32', architecture: 'x64', passed: true, cleanupConfirmed: true };
  const patch = { patchId: 'stakemode-firefox-extension-ui-v1', archives: [{ path: 'omni.ja', afterSha256: hash('a') }] };
  const page = (kind: string) => ({ kind, passed: true, authenticatedManualTextAndClick: true, exactNativeUrl: true, runtimeScheme: 'moz-extension:', openError: null, browserError: null,
    beforePixels: { sha256: hash('b'), bytes: 10000, width: 1473, height: 913 }, afterPixels: { sha256: hash('c'), bytes: 11000, width: 1473, height: 913 } });
  const browser = { ...identity, startedAt: '2026-10-16T01:01:00.000Z', finishedAt: '2026-10-16T01:05:00.000Z', checks: BROWSER_CHECKS.map(name => ({ name, passed: true, milliseconds: 50 })),
    pageErrors: [], failedRequests: [], frameErrors: [], preservedField: { fixture: true },
    browserHashes: { chromium: hash('1'), firefox: hash('2'), firefoxArchive: hash('3'), firefoxExtensionUiPatch: patch },
    firefoxAddonSmoke: { ...identity, gate: 'packaged-firefox-addon-ui', startedAt: '2026-10-16T01:00:00.000Z', finishedAt: '2026-10-16T01:00:59.000Z', checksPassed: true, nativeContentMarker: true, controlErrors: [],
      engine: { name: 'firefox', executableSha256: hash('2'), upstreamArchiveSha256: hash('3'), extensionUiPatch: structuredClone(patch) }, pages: [page('popup'), page('options')] } };
  const ownership = { capturedWebViewCount: 5, listenerCount: 1, loopbackListenerCount: 1, loopbackOnly: true, heldGenerationAndPathMatched: true };
  const details = { installed: true, nativeWindowCreated: true, installedSidecarVerified: true, installedWebViewRendered: true, gracefulNativeClose: true, ownedProcessesExited: true, uninstalled: true, passed: true, finishedAt: '2026-10-16T01:07:00.0000000Z',
    processBinding: { attempts: 2, observedRows: 9, boundRows: 9, unknownRows: 0, unresolvedObservedRows: 0, outcome: 'complete', lastFailureStage: 'transient-history', lastFailureRole: 'webview', nativeErrorCode: 299 },
    installerRejectsWithoutKilling: { sidecarOnly: true, mainAndSidecar: true },
    webViewOwnership: { beforeInspection: ownership, afterInspection: { ...ownership, sameGenerationAsBefore: true } },
    mainExecutableIntegrity: { passed: true, method: 'exact-pinned-tauri-nsis-marker', source: { repository: 'https://github.com/tauri-apps/tauri', commit: '8909f221d1515955fc843808032bdc5d62209c96', path: 'crates/tauri-bundler/src/bundle.rs', cliVersion: '2.11.4' },
      marker: { offset: 640, bytes: 27, from: '__TAURI_BUNDLE_TYPE_VAR_UNK', to: '__TAURI_BUNDLE_TYPE_VAR_NSS' }, compiled: { sha256: hash('4'), bytes: 1024 }, expected: { sha256: hash('5'), bytes: 1024 }, installed: { sha256: hash('5'), bytes: 1024 } } };
  return { browser, installed: { ...identity, startedAt: '2026-10-16T01:06:00.0000000Z', finishedAt: details.finishedAt, installedDesktop: details, checks: [{ name: INSTALLED_CHECK, passed: true, milliseconds: 60000, details }] } };
}
function merge(browser: any, installed: any) { return mergeAcceptance(browser, installed, { source: SOURCE, version: VERSION, browserSha256: hash('6'), installedSha256: hash('7'), verifiedAt: '2026-10-16T01:08:00.000Z' }); }

test('only complete independent evidence becomes a preserved 26-check release report', () => {
  const { browser, installed } = fixtures(), before = structuredClone(browser), merged = merge(browser, installed);
  expect(merged.checks).toHaveLength(26); expect(merged.checks.slice(0, 25)).toEqual(browser.checks);
  expect(merged.checks[25].name).toBe(INSTALLED_CHECK); expect(merged.installedDesktop).toEqual(installed.installedDesktop);
  expect(merged.preservedField).toEqual({ fixture: true }); expect(merged.browserFinishedAt).toBe(browser.finishedAt); expect(merged.finishedAt).toBe(installed.finishedAt);
  expect(merged.installedVerification).toMatchObject({ source: SOURCE, browserReportSha256: hash('6'), installedReportSha256: hash('7'), browserCheckCount: 25, installedCheckCount: 1 });
  expect(browser).toEqual(before);
});

test('partial, cross-source, wrong identity, missing, duplicated and failed browser evidence is rejected', () => {
  const mutations = [
    (b: any) => { b.passed = false; }, (b: any) => { b.cleanupConfirmed = false; },
    (b: any) => { b.source = 'b'.repeat(40); }, (b: any) => { b.version = 'other'; },
    (b: any) => { b.platform = 'linux'; }, (b: any) => { b.architecture = 'arm64'; },
    (b: any) => { b.checks.pop(); }, (b: any) => { b.checks[24] = structuredClone(b.checks[0]); },
    (b: any) => { b.checks[0].name = 'invented check'; }, (b: any) => { b.checks[0].passed = false; },
    ...['pageErrors', 'failedRequests', 'frameErrors'].map(key => (b: any) => { b[key].push('failure'); }),
    (b: any) => { delete b.frameErrors; }, (b: any) => { b.cleanupErrors = ['cleanup failed']; },
    (b: any) => { b.finishedAt = 'not-a-date'; }, (b: any) => { b.installedDesktop = {}; },
  ];
  for (const change of mutations) { const { browser, installed } = fixtures(); change(browser); expect(() => merge(browser, installed)).toThrow(); }
});

test('focused Firefox requires matching prepared hashes and two distinct authenticated native UI passes', () => {
  const mutations = [
    (f: any) => { f.source = 'c'.repeat(40); }, (f: any) => { f.passed = false; }, (f: any) => { f.cleanupConfirmed = false; },
    (f: any) => { f.engine.executableSha256 = hash('e'); }, (f: any) => { f.engine.upstreamArchiveSha256 = hash('e'); },
    (f: any) => { f.engine.extensionUiPatch.archives[0].afterSha256 = hash('e'); },
    (f: any) => { f.pages.pop(); }, (f: any) => { f.pages[1].kind = 'popup'; },
    (f: any) => { f.pages[0].authenticatedManualTextAndClick = false; }, (f: any) => { f.pages[1].passed = false; },
    (f: any) => { f.pages[0].openError = 'failed'; }, (f: any) => { f.controlErrors.push('failed'); },
    (f: any) => { f.pages[0].afterPixels.sha256 = f.pages[0].beforePixels.sha256; },
  ];
  for (const change of mutations) { const { browser, installed } = fixtures(); change(browser.firefoxAddonSmoke); expect(() => merge(browser, installed)).toThrow(); }
});

test('installed pass requires actual rendering, safe installer sentinels, cleanup and complete ownership', () => {
  for (const key of ['installed', 'nativeWindowCreated', 'installedSidecarVerified', 'installedWebViewRendered', 'gracefulNativeClose', 'ownedProcessesExited', 'uninstalled', 'passed']) {
    const { browser, installed } = fixtures(); installed.installedDesktop[key] = false; expect(() => merge(browser, installed)).toThrow();
  }
  const mutations = [
    (i: any) => { i.source = 'd'.repeat(40); }, (i: any) => { i.cleanupConfirmed = false; },
    (i: any) => { i.checks.push(i.checks[0]); }, (i: any) => { i.checks[0].name = 'partial install'; },
    (i: any) => { i.checks[0].details = { ...i.installedDesktop, installed: false }; },
    (i: any) => { i.installedDesktop.cleanupErrors = ['owned child survived']; },
    (i: any) => { i.installedDesktop.installerRejectsWithoutKilling.sidecarOnly = false; },
    (i: any) => { i.installedDesktop.installerRejectsWithoutKilling.mainAndSidecar = false; },
    (i: any) => { i.installedDesktop.processBinding.unknownRows = 1; },
    (i: any) => { i.installedDesktop.processBinding.unresolvedObservedRows = 1; },
    (i: any) => { i.installedDesktop.processBinding.outcome = 'partial'; },
    (i: any) => { delete i.installedDesktop.webViewOwnership.afterInspection; },
    (i: any) => { i.installedDesktop.webViewOwnership.beforeInspection.loopbackOnly = false; },
    (i: any) => { i.installedDesktop.webViewOwnership.afterInspection.sameGenerationAsBefore = false; },
    (i: any) => { i.installedDesktop.webViewOwnership.afterInspection.loopbackListenerCount = 0; },
  ];
  for (const change of mutations) { const { browser, installed } = fixtures(); change(installed); expect(() => merge(browser, installed)).toThrow(); }
});

test('installed main must match the entire expected image size, SHA256 and exact pinned marker proof', () => {
  const mutations = [
    (p: any) => { p.passed = false; }, (p: any) => { p.method = 'masked-hash'; },
    (p: any) => { p.source.commit = 'e'.repeat(40); }, (p: any) => { p.source.cliVersion = 'other'; },
    (p: any) => { p.installed.sha256 = hash('a'); }, (p: any) => { p.installed.bytes++; },
    (p: any) => { p.expected.sha256 = p.compiled.sha256; p.installed.sha256 = p.compiled.sha256; },
    (p: any) => { p.marker.to = '__TAURI_BUNDLE_TYPE_VAR_MSI'; }, (p: any) => { p.marker.bytes = 26; },
    (p: any) => { p.marker.offset = p.compiled.bytes; },
  ];
  for (const change of mutations) { const { browser, installed } = fixtures(); change(installed.installedDesktop.mainExecutableIntegrity); expect(() => merge(browser, installed)).toThrow(); }
});

test('bounded JSON inputs fail without modifying existing output; success atomically replaces the browser input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stakemode-merge-'));
  const browserPath = join(root, 'browser.json'), installedPath = join(root, 'installed.json'), outputPath = join(root, 'output.json');
  const run = () => mergeAcceptanceFiles({ browserPath, installedPath, outputPath, source: SOURCE });
  try {
    const fixture = fixtures(); await writeFile(installedPath, JSON.stringify(fixture.installed)); await writeFile(outputPath, 'KEEP EXISTING OUTPUT');
    for (const content of ['{malformed', JSON.stringify({ ...fixture.browser, cleanupConfirmed: false }), ' '.repeat(MAX_REPORT_BYTES + 1)]) {
      await writeFile(browserPath, content); await expect(run()).rejects.toThrow(); expect(await readFile(outputPath, 'utf8')).toBe('KEEP EXISTING OUTPUT');
    }
    await expect(mergeAcceptanceFiles({ browserPath: root, installedPath, outputPath, source: SOURCE })).rejects.toThrow();
    await writeFile(browserPath, JSON.stringify(fixture.browser)); await mergeAcceptanceFiles({ browserPath, installedPath, outputPath: browserPath, source: SOURCE });
    const saved = JSON.parse(await readFile(browserPath, 'utf8')); expect(saved.checks).toHaveLength(26); expect(saved.passed).toBe(true);
    expect((await readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects failed independent installed evidence and duplicate flags without overwriting output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stakemode-merge-cli-'));
  try {
    const browserPath = join(root, 'browser.json'), installedPath = join(root, 'installed.json'), outputPath = join(root, 'output.json');
    const { browser, installed } = fixtures(); installed.installedDesktop.installedWebViewRendered = false;
    await writeFile(browserPath, JSON.stringify(browser)); await writeFile(installedPath, JSON.stringify(installed)); await writeFile(outputPath, 'PRESERVE');
    const script = fileURLToPath(new URL('./merge-stakemode-acceptance.mjs', import.meta.url));
    for (const args of [ ['--browser', browserPath, '--installed', installedPath, '--source', SOURCE, '--output', outputPath], ['--browser', browserPath, '--browser', installedPath, '--source', SOURCE, '--output', outputPath] ]) {
      const child = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(1); expect(await new Response(child.stderr).text()).toContain('StakeMode acceptance merge failed:'); expect(await readFile(outputPath, 'utf8')).toBe('PRESERVE');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
