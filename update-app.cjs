'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { patchApp, indexArchive, hash } = require('./patch-app.cjs');

function headerHash(archive) {
  const index = indexArchive(archive);
  try { return hash(index.raw); } finally { fs.closeSync(index.fd); }
}

function updateApp(appPath, payloadRoot = __dirname, beforeCommit = () => {}) {
  appPath = fs.realpathSync(appPath);
  const manifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'manifest.json'), 'utf8'));
  const markerPath = path.join(appPath, 'codex-quota-queue-install.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.mod !== 'CodexQuotaQueue' || marker.packageVersion !== manifest.packageVersion) throw new Error('This is not a supported Codex Queue installation.');
  const archive = path.join(appPath, 'resources/app.asar');
  const executable = path.join(appPath, 'ChatGPT.exe');
  if (headerHash(archive) !== marker.patchedHeaderHash) throw new Error('Installed app files changed since the last patch. Nothing was updated.');
  if (headerHash(archive + '.queue-original') !== manifest.asarHeaderHash) throw new Error('The original archive backup does not match this Codex build.');
  const executableBytes = fs.readFileSync(executable);
  if (!executableBytes.includes(Buffer.from(marker.patchedHeaderHash))) throw new Error('Installed executable does not match its archive.');
  const parent = path.dirname(appPath);
  const stage = fs.mkdtempSync(path.join(parent, 'queue-update-staging-'));
  let backup;
  const moved = [], installed = [];
  try {
    fs.mkdirSync(path.join(stage, 'resources'));
    fs.copyFileSync(archive + '.queue-original', path.join(stage, 'resources/app.asar'));
    fs.copyFileSync(executable + '.queue-original', path.join(stage, 'ChatGPT.exe'));
    const result = patchApp(stage, payloadRoot);
    if (headerHash(path.join(stage, 'resources/app.asar')) !== result.patchedHeaderHash) throw new Error('Staged archive verification failed.');
    beforeCommit('staged');
    backup = fs.mkdtempSync(path.join(parent, 'queue-update-backup-'));
    const updatedMarker = JSON.parse(fs.readFileSync(path.join(stage, 'codex-quota-queue-install.json'), 'utf8'));
    updatedMarker.previousInstallationBackup = backup;
    fs.writeFileSync(path.join(stage, 'codex-quota-queue-install.json'), JSON.stringify(updatedMarker, null, 2));
    const files = ['resources/app.asar', 'ChatGPT.exe', 'codex-quota-queue-install.json'];
    for (const relative of files) {
      const source = path.join(appPath, relative), saved = path.join(backup, relative);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.renameSync(source, saved); moved.push({ source, saved });
    }
    for (const relative of files) {
      const target = path.join(appPath, relative);
      fs.renameSync(path.join(stage, relative), target); installed.push(target);
      beforeCommit(relative);
    }
    return { appPath, version: manifest.modVersion, backup, patchedHeaderHash: result.patchedHeaderHash };
  } catch (error) {
    // Restore the complete old executable/archive pair if any replacement fails.
    const failures = [];
    for (const target of installed.reverse()) {
      try { fs.renameSync(target, path.join(stage, path.basename(target) + '.failed')); } catch (failure) { failures.push(failure.message); }
    }
    for (const item of moved.reverse()) {
      try { fs.renameSync(item.saved, item.source); } catch (failure) { failures.push(failure.message); }
    }
    if (failures.length) throw new Error(`${error.message}\nRollback needs attention. Backups: ${backup}\n${failures.join('\n')}`);
    throw error;
  } finally {
    // Only remove the unique staging directory created above, never the app or its backups.
    if (path.dirname(stage) === parent && path.basename(stage).startsWith('queue-update-staging-')) fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { updateApp, headerHash };
if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node update-app.cjs EXISTING_CODEX_QUEUE_APP');
    console.log(JSON.stringify(updateApp(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
