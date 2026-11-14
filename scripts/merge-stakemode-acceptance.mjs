/** Fail-closed merger for the independent browser and installed Windows gates. */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
export const INSTALLED_CHECK = 'actual installed NSIS Tauri window, rendered WebView and owned shutdown';
export const BROWSER_CHECKS = Object.freeze([
  'actual compiled sidecar startup, packaged assets and desktop shutdown protocol',
  'prepared Windows product and isolated fixture startup',
  'HTTP authorization and authenticated WebSocket snapshot',
  'bulk creation of two Chromium and one Firefox profile',
  'real independent browser session storage',
  'public local organization and portable templates create fresh profiles without account state',
  'real Chromium and Firefox address, history and isolated tab controls',
  'private manual cookie import/export/clear stays in the selected native profile',
  'native Chromium and Firefox read-only workflows export exact fixture JSON and CSV',
  'native read-only workflow wait cancels immediately without an output or stale step',
  'app-open one-off schedule runs a real Firefox fixture inspection exactly once',
  'MV3 controller and Firefox binding safe click/input/scroll synchronization',
  'JPEG live views from Chromium and Firefox',
  'desktop and mobile dashboard render real live tiles',
  'full administrator browser UI operates the real profile and returns to the grid',
  'live local profile deletion and network mutation are rejected',
  'native memory/CPU metrics and actual Chromium heap arguments',
  'paced manual takeover cancels only its Chromium follower and preserves Firefox queued replay',
  'actual profile socket disconnect cancels pending replay and requires resume',
  'financial fixture control remains independent manual input',
  'owned force-close preserves unrelated browser profiles',
  'typed local profile deletion removes only stopped owned data',
  'native local Chromium and Firefox add-ons enforce reviewed host scope and disable on restart',
  'confirmed graceful closure of every owned remaining profile',
  'actual independent native browser proxy routing with local reserved-host fixtures',
]);
const NSIS_SOURCE = Object.freeze({ repository: 'https://github.com/tauri-apps/tauri', commit: '8909f221d1515955fc843808032bdc5d62209c96', path: 'crates/tauri-bundler/src/bundle.rs', cliVersion: '2.11.4' });
class EvidenceError extends Error {}
const fail = label => { throw new EvidenceError(label); };
const requireValue = (condition, label) => { if (!condition) fail(label); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const empty = (value, label) => requireValue(Array.isArray(value) && value.length === 0, label);
function clean(record, label) {
  requireValue(object(record), `${label}: object required`);
  for (const key of ['error', 'cleanupErrors', 'errors']) {
    if (record[key] !== undefined && record[key] !== null) requireValue(Array.isArray(record[key]) && record[key].length === 0, `${label}: error evidence present`);
  }
  requireValue(record.checkpointWriteFailed !== true && record.reportWriteFailed !== true, `${label}: report write failed`);
}
function timestamps(record, label) {
  const parse = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) ? Date.parse(value) : NaN;
  const started = parse(record.startedAt), finished = parse(record.finishedAt);
  requireValue(Number.isFinite(started) && Number.isFinite(finished) && finished >= started, `${label}: invalid completion timestamps`);
  return { started, finished };
}
function identity(record, source, version, label) {
  clean(record, label);
  requireValue(record.product === 'StakeMode' && record.version === version && record.source === source && record.platform === 'win32' && record.architecture === 'x64', `${label}: release identity mismatch`);
  requireValue(record.passed === true && record.cleanupConfirmed === true, `${label}: pass and cleanup are required`);
  return timestamps(record, label);
}
function checks(record, expected, label) {
  requireValue(Array.isArray(record.checks) && record.checks.length === expected.length, `${label}: exact check count required`);
  const names = new Set();
  for (const check of record.checks) {
    clean(check, `${label} check`);
    requireValue(typeof check.name === 'string' && expected.includes(check.name) && !names.has(check.name) && check.passed === true, `${label}: missing, duplicate, unknown or failed check`);
    names.add(check.name);
  }
}
function focusedFirefox(browser, source, version) {
  const focused = browser.firefoxAddonSmoke;
  const time = identity(focused, source, version, 'focused Firefox');
  requireValue(focused.gate === 'packaged-firefox-addon-ui' && focused.checksPassed === true && focused.nativeContentMarker === true, 'focused Firefox: native checks missing');
  empty(focused.controlErrors, 'focused Firefox: control errors present');
  const hashes = browser.browserHashes, engine = focused.engine;
  requireValue(object(hashes) && hash(hashes.chromium) && hash(hashes.firefox) && hash(hashes.firefoxArchive), 'browser: executable hashes missing');
  requireValue(object(engine) && engine.name === 'firefox' && engine.executableSha256 === hashes.firefox && engine.upstreamArchiveSha256 === hashes.firefoxArchive, 'focused Firefox: prepared engine hash mismatch');
  requireValue(object(hashes.firefoxExtensionUiPatch) && isDeepStrictEqual(engine.extensionUiPatch, hashes.firefoxExtensionUiPatch), 'focused Firefox: prepared patch mismatch');
  requireValue(Array.isArray(focused.pages) && focused.pages.length === 2, 'focused Firefox: popup and options required');
  const kinds = new Set();
  for (const page of focused.pages) {
    clean(page, 'focused Firefox page');
    requireValue(['popup', 'options'].includes(page.kind) && !kinds.has(page.kind), 'focused Firefox: duplicate or unknown page'); kinds.add(page.kind);
    requireValue(page.passed === true && page.authenticatedManualTextAndClick === true && page.exactNativeUrl === true && page.runtimeScheme === 'moz-extension:', 'focused Firefox: native manual page proof missing');
    requireValue(page.openError === null && page.browserError === null, 'focused Firefox: page error present');
    for (const key of ['beforePixels', 'afterPixels']) requireValue(object(page[key]) && hash(page[key].sha256) && integer(page[key].bytes, 1) && integer(page[key].width, 1024, 4096) && integer(page[key].height, 640, 2160), 'focused Firefox: actual pixel proof missing');
    requireValue(page.beforePixels.sha256 !== page.afterPixels.sha256, 'focused Firefox: manual input did not change pixels');
  }
  return time;
}
function installedProof(details) {
  clean(details, 'installed desktop');
  for (const key of ['installed', 'nativeWindowCreated', 'installedSidecarVerified', 'installedWebViewRendered', 'gracefulNativeClose', 'ownedProcessesExited', 'uninstalled', 'passed']) requireValue(details[key] === true, `installed desktop: ${key} must pass`);
  const sentinels = details.installerRejectsWithoutKilling;
  requireValue(object(sentinels) && sentinels.sidecarOnly === true && sentinels.mainAndSidecar === true, 'installed desktop: installer sentinel proof missing');
  const binding = details.processBinding;
  requireValue(object(binding) && binding.outcome === 'complete' && binding.unknownRows === 0 && binding.unresolvedObservedRows === 0 && integer(binding.attempts, 1) && integer(binding.observedRows, 1) && binding.boundRows === binding.observedRows, 'installed desktop: incomplete process ownership');
  for (const stage of ['beforeInspection', 'afterInspection']) {
    const proof = details.webViewOwnership?.[stage];
    requireValue(object(proof) && integer(proof.capturedWebViewCount, 1) && integer(proof.listenerCount, 1) && proof.loopbackListenerCount === proof.listenerCount && proof.loopbackOnly === true && proof.heldGenerationAndPathMatched === true, `installed desktop: ${stage} WebView ownership missing`);
    if (stage === 'afterInspection') requireValue(proof.sameGenerationAsBefore === true, 'installed desktop: WebView generation changed');
  }
  const integrity = details.mainExecutableIntegrity;
  requireValue(object(integrity) && integrity.passed === true && integrity.method === 'exact-pinned-tauri-nsis-marker' && isDeepStrictEqual(integrity.source, NSIS_SOURCE), 'installed desktop: pinned main integrity proof missing');
  for (const key of ['compiled', 'expected', 'installed']) requireValue(object(integrity[key]) && hash(integrity[key].sha256) && integer(integrity[key].bytes, 64, 256 * 1024 * 1024), 'installed desktop: invalid main digest or size');
  requireValue(integrity.expected.sha256 === integrity.installed.sha256 && integrity.expected.sha256 !== integrity.compiled.sha256 && integrity.compiled.bytes === integrity.expected.bytes && integrity.expected.bytes === integrity.installed.bytes, 'installed desktop: main payload differs');
  const marker = integrity.marker;
  requireValue(object(marker) && marker.from === '__TAURI_BUNDLE_TYPE_VAR_UNK' && marker.to === '__TAURI_BUNDLE_TYPE_VAR_NSS' && marker.bytes === 27 && integer(marker.offset, 0, integrity.compiled.bytes - marker.bytes), 'installed desktop: incorrect pinned NSIS marker');
}

/** Validate reports before constructing a release-eligible, 26-check report. */
export function mergeAcceptance(browser, installed, { source, version, browserSha256, installedSha256, verifiedAt = new Date().toISOString() }) {
  requireValue(typeof source === 'string' && /^[a-f0-9]{40}$/.test(source), 'exact 40-character source SHA required');
  requireValue(typeof version === 'string' && version.length > 0, 'application version required');
  requireValue(hash(browserSha256) && hash(installedSha256), 'input report digests required');
  const browserTime = identity(browser, source, version, 'browser');
  checks(browser, BROWSER_CHECKS, 'browser');
  requireValue(browser.installedDesktop === undefined && browser.installedVerification === undefined, 'browser: report already merged');
  for (const key of ['pageErrors', 'failedRequests', 'frameErrors']) empty(browser[key], `browser: ${key} must be empty`);
  const firefoxTime = focusedFirefox(browser, source, version);
  requireValue(firefoxTime.finished <= browserTime.started, 'focused Firefox: evidence order mismatch');
  const installedTime = identity(installed, source, version, 'installed');
  checks(installed, [INSTALLED_CHECK], 'installed');
  requireValue(installedTime.started >= browserTime.finished, 'installed: evidence order mismatch');
  installedProof(installed.installedDesktop);
  requireValue(isDeepStrictEqual(installed.checks[0].details, installed.installedDesktop), 'installed: check details differ from desktop proof');
  requireValue(installed.installedDesktop.finishedAt === installed.finishedAt, 'installed: desktop completion timestamp mismatch');
  return { ...browser, browserFinishedAt: browser.finishedAt, finishedAt: installed.finishedAt,
    checks: [...browser.checks, installed.checks[0]], installedDesktop: installed.installedDesktop,
    installedVerification: { schemaVersion: 1, source, browserReportSha256: browserSha256, installedReportSha256: installedSha256,
      browserCheckCount: BROWSER_CHECKS.length, installedCheckCount: 1, installedStartedAt: installed.startedAt, installedFinishedAt: installed.finishedAt, verifiedAt },
    passed: true, cleanupConfirmed: true };
}

async function readBoundedJson(path) {
  const entry = await lstat(path); requireValue(entry.isFile() && !entry.isSymbolicLink(), 'report input must be a regular file');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await file.stat(); requireValue(before.isFile() && integer(before.size, 2, MAX_REPORT_BYTES), 'report input exceeds the regular-file size bound');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); requireValue(read.bytesRead > 0, 'report input changed while reading'); offset += read.bytesRead; }
    const after = await file.stat(); requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino && before.dev === after.dev, 'report input changed while reading');
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('report input is not valid UTF-8 JSON'); }
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}
export async function mergeAcceptanceFiles({ browserPath, installedPath, source, outputPath }) {
  const browser = await readBoundedJson(browserPath), installed = await readBoundedJson(installedPath);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = mergeAcceptance(browser.value, installed.value, { source, version: manifest.version, browserSha256: browser.sha256, installedSha256: installed.sha256 });
  const output = resolve(outputPath), temporary = join(dirname(output), `.stakemode-acceptance-${randomBytes(12).toString('hex')}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600); await file.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8'); await file.sync(); await file.close(); file = undefined;
    await rename(temporary, output);
  } finally { if (file) await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  return result;
}
function argumentsFor(argv) {
  const names = new Map([['--browser', 'browserPath'], ['--installed', 'installedPath'], ['--source', 'source'], ['--output', 'outputPath']]), options = {};
  requireValue(argv.length === 8, 'expected --browser, --installed, --source and --output arguments');
  for (let index = 0; index < argv.length; index += 2) { const name = names.get(argv[index]), value = argv[index + 1]; requireValue(name && !Object.hasOwn(options, name) && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'invalid or duplicate merger argument'); options[name] = value; }
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await mergeAcceptanceFiles(argumentsFor(process.argv.slice(2))); console.log(`PASS StakeMode acceptance merge: ${result.checks.length} checks, exact source and confirmed cleanup.`); }
  catch (error) { console.error(`StakeMode acceptance merge failed: ${error instanceof EvidenceError ? error.message : 'bounded report read or atomic output failed'}`); process.exitCode = 1; }
}
