import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALIASMODE_VERSION } from './version.ts';
test('StakeMode product, native version and entry point align', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const native = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
  expect(pkg.name).toBe('gamebrowser'); expect(pkg.module).toBe('StakeMode-cli.ts');
  expect(pkg.version).toBe(ALIASMODE_VERSION); expect(native.version).toBe(ALIASMODE_VERSION);
  expect(native.productName).toBe('GameBrowser'); expect(native.identifier).toBe('com.solomongs.stakemode');
  expect(cargo).toContain('version = "' + ALIASMODE_VERSION + '"');
  expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
  expect(pkg.dependencies['@playwright/mcp']).toBeUndefined();
});
test('StakeMode source and distribution expose no removed feature entry point', () => {
  const config = readFileSync('src-tauri/tauri.conf.json', 'utf8');
  const prepare = readFileSync('scripts/prepare-windows-bundle.ts', 'utf8');
  const protocol = JSON.parse(readFileSync('docs/public/manifest.json', 'utf8'));
  expect(config).not.toContain('aliasmode-mcp');
  expect(prepare).toContain('StakeMode-cli.ts');
  expect(protocol.product).toBe('StakeMode'); expect(protocol.constraints.financialReplay).toBe(false);
  expect(protocol.constraints.credentialReplay).toBe(false); expect(protocol.constraints.memoryBudgetIsHardCap).toBe(false);
});
test('private release builds the separated branch with unsigned preview provenance', () => {
  const workflow = readFileSync('.github/workflows/stakemode-windows.yml', 'utf8');
  expect(workflow).toContain('branches: [stakemode]');
  expect(workflow).toContain('github.event.repository.private == true');
  expect(workflow).toContain('scripts/stakemode-acceptance.mjs');
  expect(workflow).toContain('--no-sign');
  expect(workflow).toContain('SHA256SUMS.txt');
  expect(workflow).toContain('python -m unittest discover -s sdk');
  expect(workflow).toContain('scripts/stakemode-installed-smoke.ps1');
  expect(workflow.indexOf('Verify actual installed NSIS Tauri desktop')).toBeLessThan(workflow.indexOf('Collect installer and provenance'));
  expect(workflow).toContain('$acceptance.installedDesktop.passed -ne $true');
  expect(workflow).toContain('GameBrowser_' + ALIASMODE_VERSION + '_x64-setup.exe');
  expect(workflow).toContain("$tag = 'stakemode-v" + ALIASMODE_VERSION + "'");
  expect(workflow).toContain('never overwrite a previous release');
  expect(workflow).toContain('Published release tag does not point to the validated source commit');
});
