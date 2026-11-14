/** Inspect the actual installed Tauri WebView2 through its explicit CI-only debug port. */
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.equal(process.platform, 'win32');
const [runtime, portValue, screenshot] = process.argv.slice(2);
const port = Number(portValue);
assert.ok(runtime && screenshot && Number.isSafeInteger(port) && port > 1024 && port < 65536);
const playwright = await import(pathToFileURL(join(resolve(runtime), 'node_modules', 'playwright-core', 'index.mjs')).href);
let browser;
const deadline = setTimeout(() => { console.error('Installed WebView inspection exceeded its sixty-second bound'); process.exit(1); }, 60000);
// Dashboard startup commits its selected view with history.replaceState.
const expectedWorkspace = 'http://127.0.0.1:8080/#live';
function addressCategory(value) {
  if (value === expectedWorkspace) return 'workspace-live';
  if (value === 'http://127.0.0.1:8080/') return 'workspace-root';
  if (value === 'http://127.0.0.1:8080/workspace/dashboard.html') return 'workspace-file';
  if (value === 'about:blank' || value === '') return 'blank';
  if (typeof value === 'string' && /^(?:chrome-error:|edge-error:|about:neterror)/.test(value)) return 'network-error';
  if (value === 'http://tauri.localhost/' || value === 'tauri://localhost/') return 'service-fallback';
  return 'other';
}
async function reportTargets(phase) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    assert.ok(Array.isArray(targetInfos) && targetInfos.length <= 64, 'Native target inventory remains bounded');
    const allowedTypes = new Set(['browser', 'page', 'other', 'iframe', 'background_page', 'service_worker', 'worker', 'webview']);
    const pages = browser.contexts().flatMap(context => context.pages());
    assert.ok(pages.length <= 64, 'Native page inventory remains bounded');
    console.log(JSON.stringify({ nativeTargetInventory: { phase, contextCount: browser.contexts().length,
      targets: targetInfos.map(target => ({ type: allowedTypes.has(target.type) ? target.type : 'unknown',
        address: addressCategory(target.url), expectedWorkspace: target.url === expectedWorkspace,
        workspaceTitle: target.title === 'StakeMode · Browser workspace' })),
      pages: pages.map(page => ({ closed: page.isClosed(), address: addressCategory(page.url()), expectedWorkspace: page.url() === expectedWorkspace })) } }));
  } finally { await session.detach().catch(() => {}); }
}
try {
  const readyBy = Date.now() + 20000;
  let ready = false;
  while (Date.now() < readyBy) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }); if (response.status === 200) { ready = true; break; } } catch { /* Wait for this owned native WebView's debug endpoint. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
  }
  assert.equal(ready, true, 'Owned native WebView debug endpoint becomes ready');
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  await reportTargets('connected');
  // The owned debug listener can be ready before the first navigation commits.
  // Wait only for the exact workspace page; another document never substitutes.
  const pageReadyBy = Date.now() + 20000;
  let page;
  while (Date.now() < pageReadyBy) {
    assert.equal(browser.isConnected(), true, 'Owned native WebView remains connected');
    page = browser.contexts().flatMap(context => context.pages())
      .find(item => !item.isClosed() && item.url() === expectedWorkspace);
    if (page) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
  }
  if (!page) await reportTargets('workspace-not-found');
  assert.ok(page, 'The installed native WebView displays its actual loopback workspace');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#connection-state').filter({ hasText: 'Relay connected' }).waitFor({ timeout: 20000 });
  assert.equal(await page.title(), 'StakeMode · Browser workspace');
  assert.equal(await page.locator('.live-tile').count(), 0, 'Installed GUI smoke creates no browser accounts');
  assert.equal(await page.locator('#full-admin-view').count(), 1);
  assert.equal(await page.locator('[data-view="extensions"]').count() > 0, true);
  assert.equal(await page.locator('[data-view="automation"]').count() > 0, true);
  await page.screenshot({ path: resolve(screenshot), fullPage: false });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ installedWebViewRendered: true, authenticatedRelayConnected: true, profileCount: 0, pageErrors: 0 }));
} finally {
  // CDP close detaches this inspector only. The native Tauri window owns shutdown.
  await browser?.close().catch(() => {});
  clearTimeout(deadline);
}
