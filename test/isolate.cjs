// Loaded before tests: legacy migration must never inspect the project data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raygpt-isolated-'));
process.env.RAYGPT_DATA_DIR = path.join(root, 'private');
process.env.RAYGPT_LEGACY_ROSTER_DIR = path.join(root, 'legacy');
process.env.RAYGPT_LEGACY_AUTH_FILE = path.join(root, 'legacy-auth.json');
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
