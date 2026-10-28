'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { quotaStatus } = require('./engine.cjs');

function jsonFile(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.length > 2097152) throw new Error('The account file is too large.');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function authIdentity(auth) {
  if (auth?.OPENAI_API_KEY || auth?.auth_mode && auth.auth_mode !== 'chatgpt') return null;
  try {
    const token = auth.tokens?.access_token;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const scope = claims['https://api.openai.com/auth'];
    const accountId = scope?.chatgpt_account_id ?? scope?.account_id;
    const userId = scope?.user_id ?? scope?.chatgpt_user_id;
    if (typeof accountId !== 'string' || !accountId || typeof userId !== 'string' || !userId ||
        auth.tokens.account_id !== accountId) return null;
    return { accountId, userId, expiresAt: claims.exp, key: `${userId}::${accountId}` };
  } catch { return null; }
}

const sameIdentity = (a, b) => !!a && !!b && a.accountId === b.accountId && a.userId === b.userId;

function snapshotPath(home, key) {
  const name = /^[a-zA-Z0-9_.-]+$/.test(key) && !['.', '..'].includes(key) ? key : Buffer.from(key).toString('base64url');
  return path.join(home, 'accounts', `${name}.auth.json`);
}

function switchQuery(record, records) {
  const fields = rec => [rec.alias, rec.email, rec.account_name].filter(value => typeof value === 'string' && value);
  for (const query of fields(record)) {
    if (query.startsWith('-') || query.length > 500) continue;
    const matches = records.filter(rec => fields(rec).some(value => value.toLowerCase().includes(query.toLowerCase())));
    if (matches.length === 1 && matches[0] === record) return query;
  }
  return null;
}

function findCodexAuth() {
  const name = `codex-auth-win32-${process.arch}`;
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm/node_modules/@loongphy/codex-auth/node_modules/@loongphy', name, 'bin/codex-auth.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'codex-auth/bin/codex-auth.exe'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'codex-auth.exe')),
  ];
  return candidates.find(file => file && fs.existsSync(file)) || null;
}

function runSwitch(executable, home, query) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['switch', query], {
      windowsHide: true, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // CLI output contains account details. Keep it out of the queue log and renderer.
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex Auth did not finish switching accounts.')); }, 15000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Codex Auth could not be started.')); });
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error('Codex Auth did not confirm the account switch.'));
    });
  });
}

function usageReading(body, accountId) {
  const limits = body?.rate_limit;
  const window = value => value && ({
    usedPercent: value.used_percent, windowDurationMins: value.limit_window_seconds / 60, resetsAt: value.reset_at,
  });
  return { accountId, ordinaryUsageAllowed: body?.ordinary_usage_allowed === false ? false : limits?.allowed,
    rateLimits: { limitId: 'codex', primary: window(limits?.primary_window), secondary: window(limits?.secondary_window),
      rateLimitReachedType: limits?.limit_reached ? 'usage' : null } };
}

class AccountAccess {
  constructor({ getRegistry, fetch, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    executable = findCodexAuth(), switchCommand = runSwitch, prepareExternal = () => {}, changed = () => {}, log = () => {}, now = Date.now }) {
    Object.assign(this, { getRegistry, fetch, home, executable, switchCommand, prepareExternal, changed, log, now });
    this.status = { phase: 'ready', available: false };
    this.nextSwitchAt = 0;
    this.busy = false;
  }

  snapshot() { return { ...this.status }; }
  setStatus(phase, available = this.status.available) {
    if (this.status.phase === phase && this.status.available === available) return;
    this.status = { phase, available }; this.changed();
  }
  diskIdentity() {
    try { return authIdentity(jsonFile(path.join(this.home, 'auth.json'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('The selected account file could not be read.'); }
  }
  registry() {
    try {
      const data = jsonFile(path.join(this.home, 'accounts/registry.json'));
      if (![2, 3].includes(data.schema_version) || !Array.isArray(data.accounts)) return null;
      return data;
    } catch { return null; }
  }
  connection() {
    const client = this.getRegistry()?.getMaybeConnection('local');
    if (!client || !['sendAppServerRequest', 'getAuthenticatedPrincipal', 'restart'].every(name => typeof client[name] === 'function')) {
      throw new Error('Waiting for the native Codex account connection.');
    }
    return client;
  }
  assertCurrent(client, identity) {
    const disk = this.diskIdentity();
    if (this.getRegistry()?.getMaybeConnection('local') !== client ||
        (identity.nativeOnly ? disk || this.registry() : !sameIdentity(disk, identity))) {
      throw new Error('The selected account changed. Waiting to verify it.');
    }
  }
  async request(client, identity, method, params) {
    const result = await client.sendAppServerRequest(method, params, () => this.assertCurrent(client, identity));
    this.assertCurrent(client, identity);
    return result;
  }
  assertActor(actor) {
    const disk = this.diskIdentity();
    if (this.status.phase !== 'ready' || actor.accountKey &&
        (this.nativeOnly ? disk || this.registry() : disk?.key !== actor.accountKey)) {
      throw new Error('The selected account changed before submission.');
    }
  }
  async isIdle(client, identity) {
    const loaded = await this.request(client, identity, 'thread/loaded/list', {});
    if (!Array.isArray(loaded?.data)) throw new Error('Active chats could not be verified.');
    for (const threadId of loaded.data) {
      const current = await this.request(client, identity, 'thread/read', { threadId, includeTurns: false });
      const status = current?.thread?.status;
      if (!['idle', 'notLoaded', 'systemError', 'error'].includes(typeof status === 'string' ? status : status?.type)) return false;
      try {
        const result = await this.request(client, identity, 'thread/goal/get', { threadId });
        if (result?.goal?.status === 'active') return false;
      } catch (error) { if (error.message !== 'goals feature is disabled') throw error; }
    }
    return true;
  }
  notify(client, method, params) {
    client.messageDelivery?.broadcastToWindows({ type: 'mcp-notification', hostId: 'local', method, params });
  }
  async synchronize() {
    let identity = this.diskIdentity();
    const client = this.connection();
    const principal = await client.getAuthenticatedPrincipal();
    if (!identity && !this.registry() && principal?.accountId && principal?.userId) {
      identity = { ...principal, key: `${principal.userId}::${principal.accountId}`, nativeOnly: true };
    }
    if (!identity) throw new Error('Select a saved ChatGPT account in Codex Auth.');
    this.assertCurrent(client, identity);
    if (!sameIdentity(principal, identity)) {
      const registry = this.registry();
      if (registry?.auto_switch?.enabled && registry.active_account_key === identity.key &&
          registry.accounts.some(record => record.account_key === identity.key) && principal?.accountId && principal?.userId) {
        const previous = await this.request(client, identity, 'account/rateLimits/read', { excludeResetCreditDetails: true });
        if (previous?.accountId === principal.accountId && quotaStatus(previous).known && !quotaStatus(previous).ready) {
          await this.prepareExternal({ accountId: identity.accountId, accountKey: identity.key,
            from: principal.accountId, fromKey: `${principal.userId}::${principal.accountId}` });
        }
      }
      this.setStatus('waiting-idle');
      if (!await this.isIdle(client, identity)) throw new Error('Waiting for active chats before applying the account switch.');
      this.setStatus('switching');
      this.assertCurrent(client, identity);
      // Reconnect the app-server, retaining the desktop window, drafts, and saved chats.
      await client.restart({ intent: 'reconnect' });
      this.assertCurrent(client, identity);
      if (!sameIdentity(await client.getAuthenticatedPrincipal(), identity)) {
        this.setStatus('error');
        throw new Error('Codex did not load the selected account. No queued work was sent.');
      }
      this.log('account-applied', {});
    }
    if (this.lastDiskKey !== identity.key) {
      const info = await this.request(client, identity, 'account/read', { refreshToken: false });
      if (info?.account?.type !== 'chatgpt') throw new Error('The selected ChatGPT account could not be verified.');
      this.notify(client, 'account/updated', { authMode: 'chatgpt', planType: info.account.planType ?? null });
    }
    this.lastDiskKey = identity.key;
    this.nativeOnly = identity.nativeOnly === true;
    this.setStatus('ready', !!(this.executable && (this.registry()?.accounts.length || 0) > 1));
    return { client, identity };
  }
  async readQuota() {
    const { client, identity } = await this.synchronize();
    const reading = await this.request(client, identity, 'account/rateLimits/read', { excludeResetCreditDetails: true });
    if (reading?.accountId !== identity.accountId || !sameIdentity(await client.getAuthenticatedPrincipal(), identity)) {
      throw new Error('The usage response does not match the selected account.');
    }
    this.assertCurrent(client, identity);
    this.notify(client, 'account/rateLimits/updated', reading);
    return { ...reading, accountKey: identity.key };
  }
  async candidateQuota(record, registry) {
    const auth = jsonFile(snapshotPath(this.home, record.account_key));
    const identity = authIdentity(auth);
    if (!identity || identity.key !== record.account_key || identity.accountId !== record.chatgpt_account_id ||
        !Number.isFinite(identity.expiresAt) || identity.expiresAt * 1000 <= this.now() + 30000) return null;
    if (registry.api?.usage === false) {
      // Respect Codex Auth's local-only setting; old usage cannot prove availability.
      if (!Number.isFinite(record.last_usage_at) || this.now() / 1000 - record.last_usage_at > 60 || record.last_usage_at * 1000 > this.now()) return null;
      const w = value => value && ({ usedPercent: value.used_percent, windowDurationMins: value.window_minutes, resetsAt: value.resets_at });
      return { accountId: identity.accountId, rateLimits: { limitId: 'codex', primary: w(record.last_usage?.primary), secondary: w(record.last_usage?.secondary) } };
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await this.fetch('https://chatgpt.com/backend-api/wham/usage', {
        method: 'GET', headers: { Authorization: `Bearer ${auth.tokens.access_token}`, 'ChatGPT-Account-Id': identity.accountId },
        signal: abort.signal, redirect: 'error', credentials: 'omit',
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > 2097152) return null;
      const body = JSON.parse(text);
      if (body.account_id != null && body.account_id !== identity.accountId || body.user_id != null && body.user_id !== identity.userId) return null;
      return usageReading(body, identity.accountId);
    } finally { clearTimeout(timer); }
  }
  async maybeSwitch({ accountId, accountKey, prepare }) {
    if (this.busy || this.now() < this.nextSwitchAt || !this.executable) return null;
    this.busy = true;
    try {
      const registry = this.registry(), original = this.diskIdentity();
      if (!registry || !original || original.accountId !== accountId || original.key !== accountKey || registry.auto_switch?.enabled) return null;
      this.nextSwitchAt = this.now() + 60000;
      const client = this.connection();
      if (!sameIdentity(await client.getAuthenticatedPrincipal(), original) || !await this.isIdle(client, original)) {
        this.setStatus('waiting-idle'); return null;
      }
      const originalQuota = quotaStatus(await this.request(client, original, 'account/rateLimits/read', { excludeResetCreditDetails: true }));
      if (!originalQuota.known || originalQuota.ready) return null;
      for (const record of registry.accounts) {
        if (!record?.account_key || record.account_key === original.key || record.auth_mode === 'apikey') continue;
        const query = switchQuery(record, registry.accounts);
        if (!query) continue;
        let candidate;
        try { candidate = await this.candidateQuota(record, registry); }
        catch { continue; }
        if (!quotaStatus(candidate).ready) continue;
        this.assertCurrent(client, original);
        if (!await this.isIdle(client, original)) { this.setStatus('waiting-idle'); return null; }
        const currentQuota = quotaStatus(await this.request(client, original, 'account/rateLimits/read', { excludeResetCreditDetails: true }));
        if (!currentQuota.known || currentQuota.ready) return null;
        const currentRegistry = this.registry();
        const selected = currentRegistry?.accounts.find(item => item.account_key === record.account_key);
        if (!selected || switchQuery(selected, currentRegistry.accounts) !== query || currentRegistry.auto_switch?.enabled) return null;
        await prepare({ accountId: record.chatgpt_account_id, accountKey: record.account_key });
        this.setStatus('switching');
        await this.switchCommand(this.executable, this.home, query);
        if (this.diskIdentity()?.key !== record.account_key) throw new Error('Codex Auth selected a different account. No queued work was transferred.');
        const reading = await this.readQuota();
        if (reading.accountKey !== record.account_key) throw new Error('The switched account could not be verified.');
        this.log('account-switched', {});
        return reading;
      }
      this.setStatus('ready');
      return null;
    } catch (error) { this.setStatus('error'); throw error; }
    finally { this.busy = false; }
  }
}

module.exports = { AccountAccess, authIdentity, sameIdentity, snapshotPath, switchQuery, usageReading, findCodexAuth };
