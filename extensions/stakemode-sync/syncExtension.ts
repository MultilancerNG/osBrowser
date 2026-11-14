import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { validateAllowedOrigin } from '../../workspace/eventPolicy';

export type SyncExtensionConfig = {
  profileId: string;
  token: string;
  role: 'admin' | 'follower' | 'manual';
  origins: string[];
  relayUrl: string;
};
/** Creates a private per-profile copy. Never edits distributable extension files.
 * Packaged callers may pass sourceDirectory or STAKEMODE_SYNC_EXTENSION_ROOT. */
export async function generateSyncExtension(options: {
  stateRoot: string;
  profileId: string;
  config: SyncExtensionConfig;
  sourceDirectory?: string;
  engine?: 'chromium' | 'firefox';
}): Promise<string> {
  const { profileId, config } = options;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(profileId) || config.profileId !== profileId) throw new Error('Invalid synchronizer profile identifier');
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(config.token)) throw new Error('Invalid profile-scoped synchronizer token');
  if (!['admin', 'follower', 'manual'].includes(config.role)) throw new Error('Invalid synchronizer role');
  if (!Array.isArray(config.origins) || config.origins.length > 32 || config.origins.some((value) => !validateAllowedOrigin(value))) throw new Error('Synchronizer origins must be exact HTTPS or loopback HTTP origins');
  if (config.relayUrl !== 'ws://127.0.0.1:8080/relay') throw new Error('Synchronizer relay must use the fixed loopback endpoint');
  const source = resolve(options.sourceDirectory ?? process.env.STAKEMODE_SYNC_EXTENSION_ROOT ?? import.meta.dir);
  const directory = resolve(options.stateRoot, 'sync-extensions', profileId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestName = options.engine === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';
  // Inspect manifest rather than blindly copying user-controlled runtime files.
  const manifest = JSON.parse(await readFile(resolve(source, manifestName), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.name !== 'StakeMode Synchronizer') throw new Error('Synchronizer extension source is unavailable or invalid');
  // Browser match patterns cannot restrict ports. Runtime policy still compares
  // the full exact origin, including a loopback fixture's approved port.
  const matches = [...new Set(config.origins.map((origin) => { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }))];
  manifest.host_permissions = matches;
  manifest.content_scripts = matches.length ? manifest.content_scripts.map((entry: Record<string, unknown>) => ({ ...entry, matches })) : [];
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
  for (const name of ['background.js', 'content.js', 'popup.html', 'popup.js', 'popup.css']) await copyFile(resolve(source, name), resolve(directory, name));
  const serialized = JSON.stringify({ profileId, token: config.token, role: config.role, origins: [...new Set(config.origins)], relayUrl: config.relayUrl });
  const temporary = resolve(directory, `config-${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, resolve(directory, 'config.json'));
  if (process.platform !== 'win32') await chmod(resolve(directory, 'config.json'), 0o600);
  return directory;
}

/** Remove only the generated credentials belonging to a deleted local profile. */
export function removeSyncExtension(stateRoot: string, profileId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profileId)) throw new Error('Invalid synchronizer profile identifier');
  const parent = resolve(stateRoot, 'sync-extensions');
  if (!existsSync(parent)) return;
  if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) throw new Error('Synchronizer storage is not an owned directory');
  const target = resolve(parent, profileId);
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error('Synchronizer profile storage is not an owned directory');
  rmSync(target, { recursive: true, force: true });
}
