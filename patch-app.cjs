'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function indexArchive(archive) {
  const fd = fs.openSync(archive, 'r');
  const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
  if (prefix.readUInt32LE(0) !== 4 || prefix.readUInt32LE(12) > 32 * 1024 * 1024) throw new Error('Unsupported ASAR header.');
  const raw = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, raw, 0, raw.length, 16);
  const header = JSON.parse(raw.toString('utf8'));
  const files = new Map();
  const visit = (node, prefix = '') => {
    for (const [name, value] of Object.entries(node.files || {})) {
      const key = prefix + name;
      if (value.files) visit(value, key + '/'); else files.set(key, value);
    }
  };
  visit(header);
  return { fd, base: 8 + prefix.readUInt32LE(4), raw, header, files };
}
function readFile(index, name) {
  const entry = index.files.get(name);
  if (!entry || entry.unpacked || entry.link || !Number.isSafeInteger(entry.size)) throw new Error(`Cannot patch packaged file ${name}`);
  const bytes = Buffer.alloc(entry.size);
  fs.readSync(index.fd, bytes, 0, bytes.length, index.base + Number(entry.offset));
  return bytes;
}
function replaceOnce(text, anchor, replacement) {
  if (!text.includes(anchor) || text.indexOf(anchor) !== text.lastIndexOf(anchor)) throw new Error('The installed app no longer matches a required patch point.');
  return text.replace(anchor, replacement);
}
function setEntry(header, name, entry) {
  const components = name.split('/'); let node = header;
  for (const folder of components.slice(0, -1)) node = node.files[folder] ||= { files: {} };
  node.files[components.at(-1)] = entry;
}
function integrity(bytes, blockSize = 4194304) {
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) blocks.push(hash(bytes.subarray(offset, offset + blockSize)));
  return { algorithm: 'SHA256', hash: hash(bytes), blockSize, blocks };
}

function patchApp(appPath, payloadRoot = __dirname) {
  appPath = fs.realpathSync(appPath);
  const marker = path.join(appPath, 'codex-quota-queue-install.json');
  if (fs.existsSync(marker)) throw new Error('This copy is already patched. Reinstall from the unmodified app.');
  const manifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'manifest.json'), 'utf8'));
  const archive = path.join(appPath, 'resources', 'app.asar');
  const index = indexArchive(archive);
  let output;
  try {
    if (hash(index.raw) !== manifest.asarHeaderHash) throw new Error('This Codex build is not supported. No files were changed.');
    const original = {};
    for (const [name, expected] of Object.entries(manifest.files)) {
      const bytes = readFile(index, name);
      if (hash(bytes) !== expected) throw new Error(`The installed file ${name} differs from the tested build.`);
      original[name] = bytes.toString('utf8');
    }
    const changes = new Map();
    changes.set('.vite/build/early-bootstrap.js', Buffer.from(
      'require("./quota-queue/main.cjs").install(require("electron"));\n' + original['.vite/build/early-bootstrap.js']
    ));
    changes.set('.vite/build/preload.js', Buffer.from(
      original['.vite/build/preload.js'] + '\n' + fs.readFileSync(path.join(payloadRoot, 'runtime/preload.js'), 'utf8')
    ));
    const nativeEntry = '<script type="module" crossorigin src="./assets/index-917385dafd51.js"></script>';
    let html = replaceOnce(original['webview/index.html'], nativeEntry,
      '<script src="./assets/quota-queue.js"></script>\n' + nativeEntry);
    html = replaceOnce(html, '</head>', '<link rel="stylesheet" href="./assets/quota-queue.css">\n</head>');
    changes.set('webview/index.html', Buffer.from(html));
    let primary = original['webview/assets/app-primary-bb5c3be1c98a.js'];
    const bind = 'Kpe(gn,!De&&!On&&!Pc);let zc=Gt??Ye;';
    primary = replaceOnce(primary, bind,
      'const __cqq=globalThis.codexQuotaQueue.useComposer(mZ,{kind:xe.value.kind,threadId:Ye,hostId:zi??`local`,accountId:xe.get(Lp),controller:gn,onError:gc,hasAttachments:!!(Rr.length||Wa.length||Jr.length||Gr.length||qr.length||Kr.length||ka||va||Hr.active)});Kpe(gn,!De&&!On&&!Pc);let zc=Gt??Ye;');
    const submit = 'let Ie=le;Ie==null&&Pe&&oe===`queue`';
    primary = replaceOnce(primary, submit,
      'if(x==null&&await globalThis.codexQuotaQueue?.submitIfLimited(m,D,ke))return;let Ie=le;Ie==null&&Pe&&oe===`queue`');
    primary = replaceOnce(primary, '}),Zc,(0,hZ.jsx)(Int,{conversationId:Ye,children:',
      '}),Zc,__cqq.messages.length>0&&H!=null?(0,hZ.jsx)(fR,{children:(0,hZ.jsx)(H,globalThis.codexQuotaQueue.queueProps(__cqq,{messages:[],isReorderDisabled:!0,isMessagePaused:Wi.isFailed,isInterrupted:!1,isSendNowDisabled:!0,isResponseInProgress:an,editingMessageId:null,hostId:ai,isQueueingEnabled:cr,...Oc,onQueueingChange:()=>{}}))}):null,(0,hZ.jsx)(Int,{conversationId:Ye,children:');
    primary = replaceOnce(primary, 'let Hn=je||xt||nt&&rt||_t||Dt||tn?.isLoading===!0||Ct||un,Un;',
      'const __cqqQuotaBlocked=globalThis.codexQuotaQueue.useQuotaGate(vZ,{kind:Ge.value.kind,threadId:ht,hostId:yt,accountId:Ge.get(Lp)},un);let Hn=je||xt||nt&&rt||_t||Dt||tn?.isLoading===!0||Ct||__cqqQuotaBlocked,Un;');
    primary = replaceOnce(primary, '}let Nt;t[101]!==Ue',
      '}Mt=globalThis.codexQuotaQueue.withToggle(VW,{Button:Fa,Tooltip:_d,Icon:que},Te,a,Mt,Ce);let Nt;t[101]!==Ue');
    const error = 'function gGe(e){let t=(0,pL.c)(49),{conversationId:n,hostId:r,icon:i,item:a,retryTurnId:o,turnKey:s}=e,';
    primary = replaceOnce(primary, error,
      'function gGe(e){globalThis.codexQuotaQueue?.observeError({threadId:e.conversationId,turnId:e.item.turnId,error:{codexErrorInfo:e.item.errorInfo}});let t=(0,pL.c)(49),{conversationId:n,hostId:r,icon:i,item:a,retryTurnId:o,turnKey:s}=e,');
    changes.set('webview/assets/app-primary-bb5c3be1c98a.js', Buffer.from(primary));
    let queue = original['webview/assets/queued-message-list-c3b80269114f.js'];
    queue = replaceOnce(queue, 'messageId:e.id,messageText:Ve(', 'quotaQueue:e.quotaQueue,messageId:e.id,messageText:Ve(');
    queue = replaceOnce(queue, 'let _e=s?.status===`sending`,G;',
      'if(e.quotaQueue)W=globalThis.codexQuotaQueue.renderStatus($,e.quotaQueue);let _e=s?.status===`sending`,G;');
    queue = replaceOnce(queue, 'let Y;t[65]!==U||t[66]!==W',
      'if(e.quotaQueue)J=null;let Y;t[65]!==U||t[66]!==W');
    changes.set('webview/assets/queued-message-list-c3b80269114f.js', Buffer.from(queue));
    let shared = original['webview/assets/app-shared-2d992d47c83d.js'];
    const rawError = 'case`error`:{let{error:e,willRetry:n,threadId:r,turnId:i}=t.params;';
    shared = replaceOnce(shared, rawError, rawError + 'globalThis.codexQuotaQueue?.observeError({threadId:r,turnId:i,error:e,willRetry:n});');
    changes.set('webview/assets/app-shared-2d992d47c83d.js', Buffer.from(shared));
    for (const name of ['main.cjs', 'engine.cjs', 'transport.cjs']) changes.set(`.vite/build/quota-queue/${name}`, fs.readFileSync(path.join(payloadRoot, 'runtime', name)));
    changes.set('webview/assets/quota-queue.js', fs.readFileSync(path.join(payloadRoot, 'runtime/renderer.js')));
    changes.set('webview/assets/quota-queue.css', fs.readFileSync(path.join(payloadRoot, 'runtime/renderer.css')));

    const ordered = [...index.files].filter(([, entry]) => entry.offset != null && !entry.unpacked && !entry.link)
      .sort((a, b) => Number(a[1].offset) - Number(b[1].offset));
    const streams = []; let offset = 0;
    for (const [name, entry] of ordered) {
      const replacement = changes.get(name);
      streams.push({ source: index.base + Number(entry.offset), size: entry.size, replacement });
      const updated = { ...entry, offset: String(offset) };
      if (replacement) { updated.size = replacement.length; updated.integrity = integrity(replacement, entry.integrity?.blockSize); changes.delete(name); }
      setEntry(index.header, name, updated); offset += updated.size;
    }
    for (const [name, bytes] of changes) {
      setEntry(index.header, name, { size: bytes.length, offset: String(offset), integrity: integrity(bytes) });
      streams.push({ replacement: bytes }); offset += bytes.length;
    }
    const raw = Buffer.from(JSON.stringify(index.header));
    const padding = (4 - raw.length % 4) % 4;
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(8 + raw.length + padding, 4);
    prefix.writeUInt32LE(4 + raw.length + padding, 8); prefix.writeUInt32LE(raw.length, 12);
    output = archive + '.queue-new';
    const fd = fs.openSync(output, 'wx');
    try {
      fs.writeSync(fd, prefix); fs.writeSync(fd, raw); fs.writeSync(fd, Buffer.alloc(padding));
      const buffer = Buffer.alloc(1024 * 1024);
      for (const stream of streams) {
        if (stream.replacement) { fs.writeSync(fd, stream.replacement); continue; }
        let copied = 0;
        while (copied < stream.size) {
          const count = fs.readSync(index.fd, buffer, 0, Math.min(buffer.length, stream.size - copied), stream.source + copied);
          if (!count) throw new Error('Unexpected end of original archive.');
          fs.writeSync(fd, buffer.subarray(0, count)); copied += count;
        }
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const executable = path.join(appPath, 'ChatGPT.exe');
    const bytes = fs.readFileSync(executable);
    const before = Buffer.from(manifest.asarHeaderHash);
    const position = bytes.indexOf(before);
    if (position < 0 || position !== bytes.lastIndexOf(before)) throw new Error('The app integrity record was not found exactly once.');
    const after = hash(raw); Buffer.from(after).copy(bytes, position);
    fs.copyFileSync(executable, executable + '.queue-original');
    fs.writeFileSync(executable + '.queue-new', bytes);
    fs.renameSync(executable + '.queue-new', executable);
    fs.closeSync(index.fd); index.fd = null;
    fs.renameSync(archive, archive + '.queue-original');
    fs.renameSync(output, archive); output = null;
    fs.writeFileSync(marker, JSON.stringify({ mod: 'CodexQuotaQueue', version: manifest.modVersion, packageVersion: manifest.packageVersion,
      installedAt: new Date().toISOString(), originalHeaderHash: manifest.asarHeaderHash, patchedHeaderHash: after }, null, 2));
    return { appPath, patchedHeaderHash: after, changedFiles: 11 };
  } finally {
    if (index.fd != null) fs.closeSync(index.fd);
    if (output && fs.existsSync(output)) fs.unlinkSync(output);
  }
}

module.exports = { patchApp, indexArchive, readFile, hash, integrity };
if (require.main === module) {
  try {
    const appPath = process.argv[2];
    if (!appPath) throw new Error('Usage: node patch-app.cjs PATH_TO_PRIVATE_APP_COPY');
    console.log(JSON.stringify(patchApp(appPath)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
