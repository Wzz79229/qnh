import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const launchers = [
  { file: '连接牵牛花.cmd', entry: 'connect.mjs', bridge: false },
  { file: '启动查询.cmd', entry: 'agent.mjs', bridge: true },
];
const sourceDirectory = fileURLToPath(new URL('../local-query/', import.meta.url));
const isWindows = process.platform === 'win32';
const windowsRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const systemDirectory = join(windowsRoot, 'System32');
const cmdExe = join(systemDirectory, 'cmd.exe');
const syntheticKey = 'synthetic_launcher_test_key_012345678901234567890';

// Construct an isolated environment instead of copying any real connection keys.
function childEnvironment({ path = `${dirname(process.execPath)};${systemDirectory}`, preload, marker, exitCode = 0, bridge = false } = {}) {
  return {
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    COMSPEC: cmdExe,
    TEMP: tmpdir(),
    TMP: tmpdir(),
    PATH: path,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ...(preload ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}),
    ...(marker ? { QNH_SMOKE_MARKER: marker, QNH_SMOKE_EXIT: String(exitCode) } : {}),
    ...(bridge ? { QNH_CONNECTOR_KEY: syntheticKey } : {}),
  };
}

async function launcherFixture(t, launcher) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'qnh-launcher-smoke-'));
  t.after(async () => {
    const cleanupTarget = resolve(temporaryRoot);
    assert.equal(dirname(cleanupTarget).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(cleanupTarget).startsWith('qnh-launcher-smoke-'));
    await rm(cleanupTarget, { recursive: true, force: true });
  });
  const directory = join(temporaryRoot, 'fixture space 目录');
  await mkdir(join(directory, 'node_modules', 'playwright'), { recursive: true });
  await writeFile(join(directory, 'node_modules', 'playwright', 'package.json'), '{}\n');
  await copyFile(join(sourceDirectory, launcher.file), join(directory, launcher.file));
  // Never copy real application modules. A failed preload cannot start a browser.
  const sentinel = "throw new Error('UNEXPECTED_LAUNCHER_ENTRY_EXECUTION');\n";
  await Promise.all(['connect.mjs', 'agent.mjs'].map(file => writeFile(join(directory, file), sentinel)));
  const preload = join(directory, 'smoke-preload.mjs');
  const marker = join(directory, 'smoke-result.json');
  await writeFile(preload, [
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.env.QNH_SMOKE_MARKER, JSON.stringify({ argv: process.argv, execPath: process.execPath }));',
    "process.stdout.write('QNH_LAUNCHER_SMOKE_OK\\n');",
    'process.exit(Number(process.env.QNH_SMOKE_EXIT));',
    '',
  ].join('\n'));
  return { directory, preload, marker };
}

function runLauncher(launcher, fixture, overrides = {}) {
  return spawnSync(cmdExe, ['/d', '/q', '/c', 'call', launcher.file], {
    cwd: fixture.directory,
    env: childEnvironment({ preload: fixture.preload, marker: fixture.marker, bridge: launcher.bridge, ...overrides }),
    input: '\r\n', // Allow PAUSE to finish without opening an interactive console.
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
}

async function assertSmoke(result, fixture, launcher, exitCode) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, exitCode, `Unexpected cmd exit: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /QNH_LAUNCHER_SMOKE_OK/);
  assert.equal(result.stderr, '', `Unexpected cmd diagnostic: ${result.stderr}`);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_LAUNCHER_ENTRY_EXECUTION|not recognized|[\uFFFD]/i);
  const marker = JSON.parse(await readFile(fixture.marker, 'utf8'));
  assert.deepEqual(marker.argv.slice(1), [join(fixture.directory, launcher.entry)]);
  assert.equal(typeof marker.execPath, 'string');
}

for (const launcher of launchers) {
  test(`${launcher.file} contains ASCII-only CRLF commands without a BOM`, async () => {
    const bytes = await readFile(join(sourceDirectory, launcher.file));
    assert.ok(bytes.length > 0);
    assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), false);
    assert.ok(bytes.every(byte => byte < 128), 'Batch command content must be ASCII-only');
    const source = bytes.toString('ascii');
    assert.ok(source.includes('\r\n'));
    assert.equal(/(?<!\r)\n|\r(?!\n)/u.test(source), false, 'Batch command lines must use CRLF');
  });

  for (const exitCode of [0, 23]) {
    test(`real cmd starts ${launcher.entry} and preserves exit ${exitCode}`, { skip: !isWindows, timeout: 20000 }, async t => {
      const fixture = await launcherFixture(t, launcher);
      await assertSmoke(runLauncher(launcher, fixture, { exitCode }), fixture, launcher, exitCode);
    });
  }
}

function registeredNode() {
  for (const key of ['HKLM\\SOFTWARE\\Node.js', 'HKLM\\SOFTWARE\\WOW6432Node\\Node.js']) {
    const result = spawnSync(join(systemDirectory, 'reg.exe'), ['query', key, '/v', 'InstallPath'], {
      env: childEnvironment({ path: systemDirectory }), encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;
    const installPath = result.stdout.match(/InstallPath\s+REG_SZ\s+([^\r\n]+)/u)?.[1].trim();
    if (installPath && existsSync(join(installPath, 'node.exe'))) return join(installPath, 'node.exe');
  }
  return null;
}

for (const launcher of launchers) {
  test(`real cmd finds registered Node without Node on PATH for ${launcher.entry}`, { skip: !isWindows, timeout: 20000 }, async t => {
    if (!registeredNode()) return t.skip('No HKLM Node.js InstallPath with an installed node.exe');
    const fixture = await launcherFixture(t, launcher);
    const whereNode = spawnSync(join(systemDirectory, 'where.exe'), ['node.exe'], {
      cwd: fixture.directory, env: childEnvironment({ path: systemDirectory }), encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.ifError(whereNode.error);
    assert.equal(whereNode.status, 1, 'The registry fallback fixture must not find Node on PATH');
    await assertSmoke(runLauncher(launcher, fixture, { path: systemDirectory }), fixture, launcher, 0);
  });
}
