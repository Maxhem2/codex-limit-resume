'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function readQuota(resourcesPath) {
  const child = spawn(path.join(resourcesPath, 'codex.exe'), ['app-server', '--listen', 'stdio://'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0, buffered = '';
  const rejectAll = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on('error', rejectAll);
  child.stdin.on('error', rejectAll);
  child.stdout.on('error', rejectAll);
  child.on('exit', () => rejectAll(new Error('Quota backend disconnected.')));
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    buffered += chunk.toString('utf8');
    if (buffered.length > 8388608) { rejectAll(new Error('Quota response is too large.')); child.kill(); return; }
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const item = pending.get(message.id); if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Quota query timed out.')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'codex_quota_queue', version: '1.2.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    const identity = await rpc('account/read', { refreshToken: false });
    if (identity.account?.type !== 'chatgpt') throw new Error('Sign into the desktop ChatGPT account to use quota scheduling.');
    return await rpc('account/rateLimits/read', {});
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    child.stdin.end(); child.kill();
  }
}

class AppTools {
  constructor() { this.sequence = 0; }
  async open() {
    let paths = process.env.CODEX_APP_TOOLS_PIPE_PATH ? [process.env.CODEX_APP_TOOLS_PIPE_PATH] : [];
    try { paths.push(...fs.readdirSync('\\\\.\\pipe\\').filter(name => name.startsWith('codex-browser-use-')).map(name => `\\\\.\\pipe\\${name}`)); } catch {}
    let last;
    for (const endpoint of [...new Set(paths)]) {
      try {
        await this.connect(endpoint);
        const response = await this.rpc('tools/list', { threadStartKind: 'all' });
        const tools = new Set(response.tools?.map(tool => tool.name));
        if (!['read_thread', 'send_message_to_thread'].every(name => tools.has(name))) throw new Error('App tools are not ready.');
        return;
      } catch (error) { last = error; this.close(); }
    }
    throw last || new Error('Waiting for the Codex app-tool connection.');
  }
  connect(endpoint) {
    return new Promise((resolve, reject) => {
      this.pending = new Map(); this.buffered = Buffer.alloc(0);
      const socket = this.socket = net.createConnection(endpoint);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('App connection timed out.')); }, 10000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('error', error => { clearTimeout(timer); reject(error); this.fail(error); });
      socket.on('close', () => this.fail(new Error('App connection closed.')));
      socket.on('data', bytes => {
        this.buffered = Buffer.concat([this.buffered, bytes]);
        while (this.buffered.length >= 4) {
          const size = this.buffered.readUInt32LE();
          if (!size || size > 8388608) { this.fail(new Error('Invalid app response frame.')); socket.destroy(); return; }
          if (this.buffered.length < size + 4) return;
          let message;
          try { message = JSON.parse(this.buffered.subarray(4, 4 + size)); } catch { socket.destroy(); return; }
          this.buffered = this.buffered.subarray(4 + size);
          const item = this.pending.get(message.id); if (!item) continue;
          this.pending.delete(message.id); clearTimeout(item.timer);
          message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
        }
      });
    });
  }
  fail(error) { for (const item of this.pending?.values() || []) { clearTimeout(item.timer); item.reject(error); } this.pending?.clear(); }
  close() { this.socket?.destroy(); this.fail(new Error('App connection closed.')); }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('App request timed out.')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      this.socket.write(Buffer.concat([header, body]));
    });
  }
  async tool(actor, tool, args) {
    const result = await this.rpc('tools/call', {
      namespace: 'codex_app', tool, arguments: args, callerSource: 'codex',
      callId: `quota-queue-${process.pid}-${Date.now()}-${this.sequence}`, hostId: actor.hostId,
      threadId: actor.threadId, turnId: 'quota-queue',
    });
    if (!result.success) throw new Error(`${tool} was not acknowledged by Codex.`);
    for (const item of result.contentItems || []) {
      if (item.type === 'inputText') { try { return JSON.parse(item.text); } catch {} }
    }
    throw new Error(`${tool} returned no result.`);
  }
}

async function withTools(actor, method, args) {
  const tools = new AppTools();
  try { await tools.open(); return await tools.tool(actor, method, args); }
  finally { tools.close(); }
}
module.exports = { readQuota, AppTools, withTools };
