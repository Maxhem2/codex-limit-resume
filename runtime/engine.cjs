'use strict';

const fs = require('node:fs');
const path = require('node:path');

function quotaStatus(reading) {
  const limits = reading?.rateLimitsByLimitId?.codex ?? reading?.rateLimits;
  if (!limits || (limits.limitId && limits.limitId !== 'codex')) return { ready: false, known: false };
  const windows = [limits.primary, limits.secondary];
  if (windows.some(w => !Number.isFinite(w?.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) {
    return { ready: false, known: false };
  }
  const blocked = windows.some(w => w.usedPercent >= 100) || reading.ordinaryUsageAllowed === false ||
    limits.spendControlReached === true || limits.individualLimit != null || limits.rateLimitReachedType != null;
  return {
    ready: !blocked, known: true,
    resetAt: Math.max(0, ...windows.filter(w => w.usedPercent >= 100).map(w => w.resetsAt || 0)),
    primary: limits.primary, secondary: limits.secondary,
  };
}

function usageError(error) {
  for (const field of ['codexErrorInfo', 'codex_error_info', 'code']) {
    const value = error?.[field];
    const names = typeof value === 'string' ? [value] : Object.keys(value || {});
    if (names.some(name => name.toLowerCase().replaceAll('_', '').replaceAll('-', '') === 'usagelimitexceeded')) {
      const details = typeof error.additionalDetails === 'string' ? (() => {
        try { return JSON.parse(error.additionalDetails); } catch { return null; }
      })() : error.additionalDetails;
      const limit = value?.limitId ?? value?.usageLimitExceeded?.limitId ?? error.limitId ?? details?.failure?.limitId;
      return !limit || limit === 'codex';
    }
  }
  return false;
}

function latestTurn(response) {
  const turn = response?.turns?.[0];
  if (!turn?.id) throw new Error('The latest chat turn is unavailable. Nothing was sent.');
  return turn;
}

function idle(response) {
  const status = response?.thread?.status;
  return ['idle', 'notLoaded', 'systemError', 'error'].includes(typeof status === 'string' ? status : status?.type);
}

class QueueEngine {
  constructor({ stateFile, quota, readThread, send, changed = () => {}, log = () => {}, now = Date.now }) {
    Object.assign(this, { stateFile, quota, readThread, send, changed, log, now });
    this.accountId = null;
    this.availability = { ready: false, known: false };
    this.lastError = null;
    this.busy = false;
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, accounts: {} };
    if (this.state.version !== 1 || !this.state.accounts || typeof this.state.accounts !== 'object') {
      throw new Error('Queue state is invalid. Refusing to risk duplicate sends.');
    }
    this.startupChats = new Set(Object.values(this.state.accounts).flatMap(account => Object.values(account.chats || {})));
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
    this.changed();
  }

  chat(actor, create = true) {
    if (!actor || actor.hostId !== 'local' || !/^[a-zA-Z0-9-]{8,100}$/.test(actor.threadId || '') ||
        typeof actor.accountId !== 'string' || !actor.accountId || actor.accountId.length > 200) {
      throw new Error('An existing local Codex chat and signed-in account are required.');
    }
    const account = this.state.accounts[actor.accountId] ?? (create ? (this.state.accounts[actor.accountId] = { chats: {} }) : null);
    if (!account) return null;
    return account.chats[actor.threadId] ?? (create ? (account.chats[actor.threadId] = {
      actor: { ...actor }, autoContinue: false, messages: [], autoPending: null, handled: [],
    }) : null);
  }

  snapshot(actor) {
    const chat = this.chat(actor, false);
    return {
      version: '1.2.0', quota: this.availability, lastError: this.lastError,
      accountMatches: this.accountId === actor.accountId,
      autoContinue: chat?.autoContinue || false,
      autoPending: chat?.autoPending || null,
      messages: (chat?.messages || []).filter(message => ['queued', 'attempted'].includes(message.state)).map(message => ({
        id: message.id, text: message.text, state: message.state, createdAt: message.createdAt,
      })),
    };
  }

  async enqueue(actor, text, requestId) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('Enter a text message of up to 200,000 characters.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) throw new Error('A message request ID is required.');
    const chat = this.chat(actor);
    if (chat.messages.some(message => message.id === requestId)) { this.save(); return this.snapshot(actor); }
    const pending = chat.messages.filter(message => ['queued', 'attempted'].includes(message.state));
    if (pending.length >= 50) throw new Error('This chat already has 50 scheduled messages.');
    const current = await this.readThread(actor);
    if (chat.messages.some(message => message.id === requestId)) { this.save(); return this.snapshot(actor); }
    if (chat.messages.filter(message => ['queued', 'attempted'].includes(message.state)).length >= 50) throw new Error('This chat already has 50 scheduled messages.');
    chat.messages.push({ id: requestId, text, state: 'queued', createdAt: this.now(), baseTurnId: latestTurn(current).id });
    chat.autoPending = null;
    this.save();
    this.log('message-queued', { threadId: actor.threadId, id: requestId });
    return this.snapshot(actor);
  }

  async preference(actor, enabled) {
    const chat = this.chat(actor);
    chat.autoContinue = enabled === true;
    if (!chat.autoContinue) chat.autoPending = null;
    else {
      const current = await this.readThread(actor);
      const turn = latestTurn(current);
      chat.autoIgnoreTurnId = idle(current) ? turn.id : null;
      // Enabling this option while limited explicitly opts this chat into the current wait.
      if (idle(current)) {
        if (this.accountId === actor.accountId && this.availability.known && !this.availability.ready) this.markAuto(chat, turn.id, 'enabled-while-limited');
        else if (this.accountId !== actor.accountId || !this.availability.known) chat.armForTurn = turn.id;
      }
    }
    this.save();
    return this.snapshot(actor);
  }

  markAuto(chat, turnId, reason) {
    if (!chat.autoContinue || chat.handled.includes(turnId) || chat.messages.some(message => ['queued', 'attempted'].includes(message.state))) return;
    chat.autoPending = { turnId, reason, state: 'queued', noticedAt: this.now() };
  }

  async observe(actor, { turnId, error, willRetry }) {
    if (willRetry || !usageError(error)) return;
    const chat = this.chat(actor, false);
    if (!chat?.autoContinue || !turnId) return;
    const current = await this.readThread(actor);
    if (latestTurn(current).id !== turnId || turnId === chat.autoIgnoreTurnId) return;
    this.markAuto(chat, turnId, 'structured-usage-error');
    this.save();
  }

  cancel(actor, id) {
    const chat = this.chat(actor);
    const message = chat.messages.find(message => message.id === id);
    if (!message || message.state !== 'queued') throw new Error('Only a message that has not been submitted can be cancelled.');
    chat.messages.splice(chat.messages.indexOf(message), 1);
    this.save();
    return this.snapshot(actor);
  }

  review(actor, id) {
    const chat = this.chat(actor);
    const message = chat.messages.find(message => message.id === id && message.state === 'attempted');
    if (message) message.state = 'reviewed';
    else if (chat.autoPending?.turnId === id && chat.autoPending.state === 'attempted') {
      chat.autoPending = null;
      chat.autoContinue = false;
      delete chat.armForTurn;
    }
    else throw new Error('This entry does not need a send review.');
    this.save();
    return this.snapshot(actor);
  }

  cancelAuto(actor, id) {
    const chat = this.chat(actor);
    if (!chat.autoPending || chat.autoPending.turnId !== id || chat.autoPending.state !== 'queued') {
      throw new Error('Only a continuation that has not been submitted can be cancelled.');
    }
    chat.handled.push(id);
    chat.autoPending = null;
    chat.autoContinue = false;
    delete chat.armForTurn;
    this.save();
    return this.snapshot(actor);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const reading = await this.quota();
      if (!reading?.accountId) throw new Error('Quota account identity is unavailable.');
      this.accountId = reading.accountId;
      this.availability = quotaStatus(reading);
      this.lastError = null;
      const chats = Object.values(this.state.accounts[this.accountId]?.chats || {});
      for (const chat of chats) {
        try { await this.processChat(chat); }
        catch (error) { this.log('chat-check-failed', { threadId: chat.actor.threadId, error: error.message }); this.lastError = error.message; }
      }
    } catch (error) {
      this.availability = { ready: false, known: false };
      this.lastError = error.message;
      this.log('quota-check-failed', { error: error.message });
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  async processChat(chat) {
    if (!chat.autoContinue && !chat.messages.some(message => message.state === 'queued')) return;
    const current = await this.readThread(chat.actor);
    const turn = latestTurn(current);
    if (this.startupChats.delete(chat) && !chat.autoPending && !chat.messages.some(message => ['queued', 'attempted'].includes(message.state)) && idle(current)) {
      chat.autoIgnoreTurnId = turn.id;
      this.save();
    }
    if (chat.armForTurn && this.availability.known) {
      if (chat.armForTurn === turn.id && !this.availability.ready) this.markAuto(chat, turn.id, 'enabled-while-limited');
      delete chat.armForTurn;
      this.save();
    }
    if (chat.autoContinue && turn.id !== chat.autoIgnoreTurnId && usageError(turn.error)) {
      this.markAuto(chat, turn.id, 'structured-latest-error');
      this.save();
    }
    if (chat.autoPending && chat.autoPending.turnId !== turn.id) { chat.autoPending = null; this.save(); }
    if (!idle(current) || !this.availability.ready) return;
    if (chat.messages.some(message => message.state === 'attempted') || chat.autoPending?.state === 'attempted') return;
    const message = chat.messages.find(message => message.state === 'queued');
    const automatic = !message && chat.autoContinue && chat.autoPending?.state === 'queued' ? chat.autoPending : null;
    if (!message && !automatic) return;
    if (automatic && chat.lastAutoAttemptAt && this.now() - chat.lastAutoAttemptAt < 300000) return;
    const freshQuota = await this.quota();
    if (freshQuota.accountId !== chat.actor.accountId || !quotaStatus(freshQuota).ready) return;
    const checked = await this.readThread(chat.actor);
    if (!idle(checked) || latestTurn(checked).id !== turn.id) return;
    if (automatic && automatic.turnId !== turn.id) return;
    if (automatic && (!chat.autoContinue || chat.autoPending !== automatic || chat.messages.some(message => message.state === 'queued'))) return;
    if (message && (!chat.messages.includes(message) || message.state !== 'queued')) return;
    const item = message || automatic;
    item.state = 'attempted'; item.attemptedAt = this.now(); chat.lastAttemptAt = this.now();
    if (automatic) { chat.lastAutoAttemptAt = this.now(); chat.handled.push(automatic.turnId); }
    this.save(); // Persist before submitting; an uncertain result must never be retried automatically.
    try {
      await this.send(chat.actor, message ? message.text : 'Continue');
      item.state = 'sent'; item.sentAt = this.now();
      if (automatic) { chat.autoPending = null; }
      else { chat.autoPending = null; }
      chat.handled = chat.handled.slice(-100);
      this.save();
      this.log('message-sent', { threadId: chat.actor.threadId, id: message?.id || automatic.turnId, automatic: !!automatic });
    } catch (error) {
      this.save();
      this.log('send-uncertain', { threadId: chat.actor.threadId, error: error.message });
      throw new Error('A send was not acknowledged. Check this chat before sending again.');
    }
  }
}

module.exports = { QueueEngine, quotaStatus, usageError, latestTurn, idle };
