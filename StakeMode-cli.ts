import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Launcher } from './launcher.ts';
import { ProfileStore } from './store.ts';
import { StakeModeWorkspace } from './workspace/server.ts';
import { desktopHealthMetadata, desktopReadyRecord, isDesktopShutdownCommand, DESKTOP_PROTOCOL } from './desktop-runtime.ts';
import { ALIASMODE_VERSION } from './version.ts';
import { verifyPlaywrightRuntime } from './playwright-runtime.ts';

function flag(args: string[], name: string): string | undefined { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; }
export interface StakeModeStartOptions { stateRoot?: string; desktopRoot?: string; binaryPath?: string; binarySha256?: string; firefoxBinaryPath?: string; firefoxBinarySha256?: string; }
export async function startStakeMode(options: StakeModeStartOptions = {}) {
  const root = resolve(options.stateRoot ?? process.env.STAKEMODE_STATE_ROOT ?? join(process.env.LOCALAPPDATA || homedir(), 'StakeMode'));
  mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 });
  const resourceRoot = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
  const assetsRoot = resourceRoot ? join(resourceRoot, 'stakemode', 'workspace') : join(import.meta.dir, 'workspace');
  process.env.STAKEMODE_SYNC_EXTENSION_ROOT ??= resourceRoot ? join(resourceRoot, 'stakemode', 'extensions', 'stakemode-sync') : join(import.meta.dir, 'extensions', 'stakemode-sync');
  await verifyPlaywrightRuntime(resourceRoot);
  const health = options.desktopRoot ? desktopHealthMetadata(process.env, options.desktopRoot) : null;
  const store = new ProfileStore(join(root, 'profiles.sqlite'));
  let workspace: StakeModeWorkspace | undefined;
  const log = (message: string) => {
    const sanitized = message.replace(/(https?:\/\/|socks5?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
    appendFileSync(join(root, 'logs', 'stakemode-' + new Date().toISOString().slice(0, 10) + '.log'), new Date().toISOString() + ' ' + sanitized + '\n', { mode: 0o600 });
    console.error('[GameBrowser] ' + sanitized);
  };
  const launcher = new Launcher({ store, dataRoot: join(root, 'profiles'), headless: true, log,
    // Profile dimensions describe its desktop browser, independently of the
    // dashboard tile or the device used to view the workspace.
    windowWidthScale: 1, windowHeightScale: 1,
    // The workspace labels each profile outside its page. Preserve website
    // document titles instead of injecting the legacy native-window labeler.
    labelWindow: async () => {},
    binaryPath: options.binaryPath, expectedBinarySha256: options.binarySha256,
    firefoxBinaryPath: options.firefoxBinaryPath, expectedFirefoxBinarySha256: options.firefoxBinarySha256,
    profileExtensionDirs: profile => workspace?.extensionDirectories(profile) ?? [],
    profileNetworkMode: profile => workspace?.manager.getNetworkMode(profile.id),
    profileFirefoxAddonDirs: profile => workspace?.firefoxAddonDirectories(profile) ?? [],
    profileFirefoxAddonUUIDs: profile => workspace?.firefoxAddonUUIDs(profile) ?? {},
    profileResourceLimits: profile => profile.engine === 'firefox' ? undefined : { v8OldSpaceMb: workspace?.manager.getProfile(profile.id)?.heapMb ?? 512, deviceScaleFactor: 1 },
  });
  const assets = Object.fromEntries(['dashboard.html', 'dashboard.js', 'dashboard.css'].map(name => ['/workspace/' + name, {
    body: readFileSync(join(assetsRoot, name), 'utf8'), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
  }]));
  workspace = new StakeModeWorkspace({ launcher, store, stateRoot: root, assets,
    extraFetch: (request, address) => {
      if (new URL(request.url).pathname !== '/ui/api/health') return undefined;
      if (request.method !== 'GET' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return new Response('Loopback only', { status: 403 });
      return Response.json({ ok: true, ...(health ?? { version: ALIASMODE_VERSION, root }), pid: process.pid, activeBrowserCount: store.listLaunches().length, readiness: 'local', product: 'StakeMode' }, { headers: { 'cache-control': 'no-store' } });
    },
  });
  try { await launcher.reconcileOrphans(); await launcher.certifySurvivors(); const port = await workspace.start();
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      await workspace!.stop();
      const results = await Promise.all(store.listLaunches().map(p => launcher.stop(p.profileId)));
      if (results.some(result => !result) || store.listLaunches().length) throw new Error('Owned browser shutdown could not be confirmed');
      store.close();
    })();
    return { root, port, url: `http://127.0.0.1:${port}/workspace/dashboard.html`, health, launcher, workspace, store, close };
  } catch (error) { await workspace.stop().catch(() => {}); store.close(); throw error; }
}

/** Portable GameBrowser layout: GameBrowser.exe next to runtime\, cloakbrowser\ and firefox\.
 * Fills only variables the caller has not set, and pins each engine to the hash found at startup. */
function applyPortableLayout(): boolean {
  const exeDir = dirname(process.execPath);
  if (!/gamebrowser/i.test(basename(process.execPath)) || !existsSync(join(exeDir, 'runtime', 'node_modules'))) return false;
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  process.env.ALIASMODE_PLAYWRIGHT_RUNTIME ??= join(exeDir, 'runtime');
  const chrome = join(exeDir, 'cloakbrowser', 'chrome.exe');
  if (!process.env.CLOAKBROWSER_BINARY_PATH && existsSync(chrome)) { process.env.CLOAKBROWSER_BINARY_PATH = chrome; process.env.CLOAKBROWSER_BINARY_SHA256 = sha(chrome); }
  const firefox = join(exeDir, 'firefox', 'aliasmode.exe');
  if (!process.env.ALIASMODE_FIREFOX_BINARY_PATH && existsSync(firefox)) { process.env.ALIASMODE_FIREFOX_BINARY_PATH = firefox; process.env.ALIASMODE_FIREFOX_BINARY_SHA256 = sha(firefox); }
  process.env.CLOAKBROWSER_DOWNLOAD_URL ??= '';
  process.env.STAKEMODE_STATE_ROOT ??= join(process.env.LOCALAPPDATA || homedir(), 'GameBrowser');
  return true;
}
export async function main(args = process.argv.slice(2)) {
  const portable = applyPortableLayout();
  if (portable && (!args.length || args[0]?.startsWith('--'))) args = ['start', ...args];
  if (args.includes('--help') || args[0] === 'help') { console.log('GameBrowser: GameBrowser.exe start [--state-root PATH]. Windows installer includes both browser engines.'); return; }
  if (args[0] && !['start', 'serve'].includes(args[0])) throw new Error('GameBrowser supports start/serve only; removed AI, Stake1 and DPN commands are unavailable');
  const runtime = await startStakeMode({ stateRoot: flag(args, 'state-root'), desktopRoot: flag(args, 'desktop-root'),
    binaryPath: flag(args, 'binary'), binarySha256: flag(args, 'binary-sha256'), firefoxBinaryPath: flag(args, 'firefox-binary'), firefoxBinarySha256: flag(args, 'firefox-sha256') });
  let exiting = false;
  const shutdown = () => {
    if (exiting) return; exiting = true;
    void runtime.close().then(() => { if (runtime.health) process.stdout.write(JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: 'shutdown-complete', nonce: runtime.health.instance }) + '\n'); process.exit(0); })
      .catch(() => { if (runtime.health) process.stdout.write(JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: 'shutdown-failed', nonce: runtime.health.instance }) + '\n'); console.error('StakeMode could not confirm safe shutdown'); process.exit(1); });
  };
  if (runtime.health) {
    let input = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; if (input.length > 65536) { shutdown(); return; } let newline; while ((newline = input.indexOf('\n')) >= 0) { const line = input.slice(0, newline); input = input.slice(newline + 1); if (isDesktopShutdownCommand(line, runtime.health!.instance)) shutdown(); } });
    process.stdin.once('end', shutdown); process.stdin.once('close', shutdown);
    process.stdout.write(JSON.stringify(desktopReadyRecord(runtime.health.instance, runtime.port)) + '\n');
  } else {
    console.log('GameBrowser workspace: ' + runtime.url);
    if (portable && !args.includes('--no-open')) { try { Bun.spawn(['cmd', '/c', 'start', '', runtime.url], { stdout: 'ignore', stderr: 'ignore' }); } catch { /* open the printed URL manually */ } }
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.on('message', (message: any) => { if (message?.type === 'stakemode:stop') shutdown(); });
}
if (import.meta.main) void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
