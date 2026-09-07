// Where RayGPT's private, per-account data (today: soccer rosters) actually
// lives on disk. This is deliberately NOT under the git repository — a repo
// directory can end up copied, zipped, pushed, or backed up as a unit, and
// none of that should ever carry a real kid's name and stats along for the
// ride. Configurable via RAYGPT_DATA_DIR; defaults to an OS-appropriate,
// per-user application-data folder outside any project checkout.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function defaultPrivateDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'RayGPT');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'RayGPT');
  }
  // Linux and other POSIX platforms: XDG Base Directory spec.
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgDataHome, 'RayGPT');
}

class PrivateDataConfigError extends Error {}

// path.resolve() already does the right thing for both cases: an absolute
// configured path is normalized as-is, a relative one resolves against the
// current working directory the server was started from (the standard
// convention for a CLI-configured directory, not the project root — the
// whole point here is escaping the project root).
function resolvePrivateDataDir() {
  const configured = process.env.RAYGPT_DATA_DIR;
  const resolved = path.resolve(configured ? configured.trim() : defaultPrivateDataDir());

  if (resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new PrivateDataConfigError(
      `RAYGPT_DATA_DIR resolves to "${resolved}", which is inside the project repository. ` +
        'Private data must live outside the repo — set RAYGPT_DATA_DIR to a path elsewhere, or unset it to use the default.'
    );
  }
  return resolved;
}

// Restrictive permissions where the platform supports them (POSIX modes are
// a no-op on Windows, chmod there just won't throw) — this directory can
// hold real names, so it shouldn't be group/world-readable by default.
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort — some filesystems/platforms don't support POSIX modes.
  }
  return dir;
}

// Writes never happen in place: content lands in a sibling temp file first,
// then a single fs.renameSync swaps it into the real path. Rename within
// the same directory is atomic on every filesystem this app runs on, so a
// reader never observes a half-written file, and a crash mid-write leaves
// the previous version untouched rather than a corrupt one.
function atomicWriteFileSync(filePath, content, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(tmpPath, content, { mode });
  try {
    fs.chmodSync(tmpPath, mode);
  } catch {
    // Best-effort — some filesystems/platforms don't support POSIX modes.
  }
  fs.renameSync(tmpPath, filePath);
}

module.exports = {
  PrivateDataConfigError,
  REPO_ROOT,
  resolvePrivateDataDir,
  ensurePrivateDir,
  atomicWriteFileSync,
};
