// Uses Node's built-in test runner (`node --test`) — no new dependency,
// consistent with this project's minimal-dependencies approach elsewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TMP_ROOT = path.join(require('node:os').tmpdir(), 'raygpt-test-privateData-' + process.pid);

test('privateData.js', async (t) => {
  await t.test('resolvePrivateDataDir defaults outside the repo', () => {
    delete process.env.RAYGPT_DATA_DIR;
    const { resolvePrivateDataDir, REPO_ROOT } = require('../lib/privateData');
    const dir = resolvePrivateDataDir();
    assert.ok(!dir.startsWith(REPO_ROOT), `default private dir must be outside the repo, got ${dir}`);
  });

  await t.test('resolvePrivateDataDir accepts an absolute path outside the repo', () => {
    process.env.RAYGPT_DATA_DIR = TMP_ROOT;
    const { resolvePrivateDataDir } = require('../lib/privateData');
    assert.strictEqual(resolvePrivateDataDir(), TMP_ROOT);
    delete process.env.RAYGPT_DATA_DIR;
  });

  await t.test('resolvePrivateDataDir rejects a path inside the repo', () => {
    const { resolvePrivateDataDir, PrivateDataConfigError, REPO_ROOT } = require('../lib/privateData');
    process.env.RAYGPT_DATA_DIR = path.join(REPO_ROOT, 'data', 'rosters');
    assert.throws(() => resolvePrivateDataDir(), PrivateDataConfigError);
    process.env.RAYGPT_DATA_DIR = REPO_ROOT;
    assert.throws(() => resolvePrivateDataDir(), PrivateDataConfigError);
    delete process.env.RAYGPT_DATA_DIR;
  });

  await t.test('ensurePrivateDir creates a directory with restrictive permissions', () => {
    const { ensurePrivateDir } = require('../lib/privateData');
    const dir = path.join(TMP_ROOT, 'perm-check');
    fs.rmSync(dir, { recursive: true, force: true });
    ensurePrivateDir(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    assert.strictEqual(mode, 0o700);
  });

  await t.test('atomicWriteFileSync writes correctly and leaves no temp files', () => {
    const { atomicWriteFileSync, ensurePrivateDir } = require('../lib/privateData');
    const dir = path.join(TMP_ROOT, 'atomic-check');
    ensurePrivateDir(dir);
    const target = path.join(dir, 'test.json');
    atomicWriteFileSync(target, JSON.stringify({ ok: true }));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true });
    const fileMode = fs.statSync(target).mode & 0o777;
    assert.strictEqual(fileMode, 0o600);
    const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepStrictEqual(leftoverTmp, []);
  });

  await t.test('atomicWriteFileSync failure leaves the previous file untouched', () => {
    const { atomicWriteFileSync, ensurePrivateDir } = require('../lib/privateData');
    const dir = path.join(TMP_ROOT, 'atomic-fail-check');
    ensurePrivateDir(dir);
    const target = path.join(dir, 'roster.json');
    atomicWriteFileSync(target, 'ORIGINAL CONTENT');

    // Shadow the destination's own directory with a file to force the
    // rename step to fail — permission-based failure simulation doesn't
    // work here since tests may run as root.
    fs.renameSync(dir, dir + '-swap');
    fs.writeFileSync(dir, 'this directory is now a plain file');
    let threw = false;
    try {
      atomicWriteFileSync(target, 'SHOULD NOT PERSIST');
    } catch {
      threw = true;
    } finally {
      fs.unlinkSync(dir);
      fs.renameSync(dir + '-swap', dir);
    }
    assert.ok(threw, 'a write that cannot complete must throw');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'ORIGINAL CONTENT');
  });

  t.after(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });
});
