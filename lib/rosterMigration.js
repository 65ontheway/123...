// One-time migration of roster files from the old in-repo location
// (data/rosters/, still git-ignored but sitting inside the checkout) to the
// new private data directory (see privateData.js). Runs once at server
// startup; safe to run again on every startup after that — a file that's
// already been copied is left alone (its presence at the destination is
// itself the "already migrated" signal), and the legacy copy is never
// deleted, so there's no window where a bug here could lose someone's
// roster.
const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./privateData');

const LEGACY_ROSTER_DIR = path.join(__dirname, '..', 'data', 'rosters');

function isValidRosterShape(parsed) {
  return !!parsed && typeof parsed === 'object' && Array.isArray(parsed.players);
}

// Returns a summary of what happened, by filename only — never player
// names, ratings, or any other roster content.
function migrateLegacyRosters(newRosterDir, legacyRosterDir = LEGACY_ROSTER_DIR) {
  const summary = { migrated: [], conflicts: [], skippedInvalid: [], errors: [] };

  let legacyFiles;
  try {
    legacyFiles = fs.readdirSync(legacyRosterDir).filter((f) => f.endsWith('.json'));
  } catch {
    return summary; // no legacy directory at all — nothing to migrate
  }
  if (legacyFiles.length === 0) return summary;

  fs.mkdirSync(newRosterDir, { recursive: true, mode: 0o700 });

  for (const filename of legacyFiles) {
    const legacyPath = path.join(legacyRosterDir, filename);
    const destPath = path.join(newRosterDir, filename);

    if (fs.existsSync(destPath)) {
      // Already migrated in a prior run, or something else is already
      // there — either way, never overwrite. Only flag as a conflict if
      // the two don't already agree (an identical destination is just the
      // normal "already migrated" case, not a problem to report).
      try {
        const existing = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        const source = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (JSON.stringify(existing) !== JSON.stringify(source)) {
          summary.conflicts.push(filename);
        }
      } catch {
        summary.conflicts.push(filename);
      }
      continue;
    }

    let rawSource;
    try {
      rawSource = fs.readFileSync(legacyPath, 'utf8');
    } catch {
      summary.errors.push({ file: filename, reason: 'unreadable' });
      continue;
    }

    let parsedSource;
    try {
      parsedSource = JSON.parse(rawSource);
    } catch {
      summary.skippedInvalid.push(filename);
      continue;
    }
    if (!isValidRosterShape(parsedSource)) {
      summary.skippedInvalid.push(filename);
      continue;
    }

    try {
      atomicWriteFileSync(destPath, rawSource, { mode: 0o600 });
    } catch {
      summary.errors.push({ file: filename, reason: 'write-failed' });
      continue;
    }

    // Validate the migrated copy actually matches before trusting it —
    // never switch reads/writes over to a copy that didn't verify.
    let verify = null;
    try {
      verify = JSON.parse(fs.readFileSync(destPath, 'utf8'));
    } catch {
      // leave verify as null — falls through to the failure branch below
    }
    const verifiedOk =
      verify && isValidRosterShape(verify) && JSON.stringify(verify) === JSON.stringify(parsedSource);
    if (!verifiedOk) {
      try {
        fs.unlinkSync(destPath);
      } catch {
        // best-effort cleanup of the bad copy
      }
      summary.errors.push({ file: filename, reason: 'verification-failed' });
      continue;
    }

    summary.migrated.push(filename);
  }

  return summary;
}

module.exports = { migrateLegacyRosters, LEGACY_ROSTER_DIR };
