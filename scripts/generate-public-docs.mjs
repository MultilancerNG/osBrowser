import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = {
  product: 'StakeMode', version: packageJson.version, transport: 'loopback HTTP and authenticated WebSocket',
  origin: 'http://127.0.0.1:8080', websocket: 'ws://127.0.0.1:8080/relay',
  authentication: { bootstrapHeader: 'X-StakeMode-Workspace: 1', apiHeader: 'Authorization: Bearer <session token>', websocket: 'first HELLO packet; no URL tokens', maxPayloadBytes: 32768 },
  endpoints: [
    ['GET', '/workspace/api/bootstrap', 'Create a bounded dashboard session token'],
    ['GET', '/workspace/api/snapshot', 'Profiles, verified metrics, relay state'],
    ['POST', '/workspace/api/bulk', 'Create isolated profiles; max 256 total, four concurrent launches'],
    ['POST', '/workspace/api/start', 'Launch a profile headlessly'],
    ['POST', '/workspace/api/stop', 'Stop an exactly owned browser generation'],
    ['POST', '/workspace/api/kill', 'Confirmed force stop using process ownership proof'],
    ['POST', '/workspace/api/manual', 'Cancel replay and use direct selected-profile controls'],
    ['POST', '/workspace/api/role', 'Choose admin, follower or manual'],
    ['POST', '/workspace/api/pause', 'Pause synchronization and invalidate pending events'],
    ['POST', '/workspace/api/navigate', 'Navigate an approved exact-origin HTTPS page'],
    ['POST', '/workspace/api/settings', 'Configure approved origins and fast/paced dispatch'],
  ].map(([method, path, purpose]) => ({ method, path, purpose })),
  constraints: { credentialReplay: false, financialReplay: false, automaticReconnectReplay: false, staleGenerationReplay: false, realBrowserStreams: true, memoryBudgetIsHardCap: false },
};
const contents = JSON.stringify(manifest, null, 2) + '\n';
const path = resolve(root, 'docs/public/manifest.json');
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== contents) throw new Error('StakeMode protocol documentation is stale');
} else { mkdirSync(resolve(root, 'docs/public'), { recursive: true }); writeFileSync(path, contents); }
