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

const failureReasons = new Set(['structured-usage-error', 'structured-latest-error', 'usage-limited-goal']);
function usageFailure(chat, turn, goal) {
  return usageError(turn.error) || goal?.status === 'usageLimited' || chat.lastUsageFailure?.turnId === turn.id ||
    chat.autoPending?.turnId === turn.id && failureReasons.has(chat.autoPending.reason);
}

function failureReason(turn, goal) {
  return goal?.status === 'usageLimited' ? 'usage-limited-goal' : usageError(turn.error) ? 'structured-latest-error' : 'structured-usage-error';
}

class QueueEngine {
  constructor({ stateFile, quota, readThread, send, readGoal = async () => null,
    resumeGoal = async () => { throw new Error('Native goal resume is unavailable.'); },
    switchAccount = async () => null, accountStatus = () => null,
    changed = () => {}, log = () => {}, now = Date.now }) {
    Object.assign(this, { stateFile, quota, readThread, send, readGoal, resumeGoal, switchAccount, accountStatus, changed, log, now });
    this.accountId = null;
    this.accountKey = null;
    this.availability = { ready: false, known: false };
    this.lastError = null;
    this.chatErrors = new Map();
    this.busy = false;
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, accounts: {} };
    if (this.state.version !== 1 || !this.state.accounts || typeof this.state.accounts !== 'object') {
      throw new Error('Queue state is invalid. Refusing to risk duplicate sends.');
    }
    this.startupChats = new Set(Object.values(this.state.accounts).flatMap(account =>
      [account, ...Object.values(account.profiles || {})].flatMap(profile => Object.values(profile.chats || {}))));
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
    this.changed();
  }

  accountChats(accountId, accountKey, create = true) {
    const account = this.state.accounts[accountId] ?? (create ? (this.state.accounts[accountId] = { chats: {} }) : null);
    if (!account) return null;
    if (accountKey && !account.ownerKey) {
      account.ownerKey = accountKey;
      for (const chat of Object.values(account.chats)) chat.actor.accountKey = accountKey;
      this.save();
    }
    if (!accountKey || account.ownerKey === accountKey) return account.chats;
    const profiles = account.profiles ?? (create ? (account.profiles = {}) : {});
    return (profiles[accountKey] ?? (create ? (profiles[accountKey] = { chats: {} }) : null))?.chats;
  }

  chat(actor, create = true) {
    if (!actor || actor.hostId !== 'local' || !/^[a-zA-Z0-9-]{8,100}$/.test(actor.threadId || '') ||
        typeof actor.accountId !== 'string' || !actor.accountId || actor.accountId.length > 200) {
      throw new Error('An existing local Codex chat and signed-in account are required.');
    }
    const accountKey = actor.accountKey || (actor.accountId === this.accountId ? this.accountKey : null);
    const chats = this.accountChats(actor.accountId, accountKey, create);
    if (!chats) return null;
    return chats[actor.threadId] ?? (create ? (chats[actor.threadId] = {
      actor: { ...actor, ...(accountKey ? { accountKey } : {}) }, autoContinue: false, messages: [], autoPending: null, handled: [],
    }) : null);
  }

  snapshot(actor) {
    const chat = this.chat(actor, false);
    return {
      version: '1.4.0', quota: this.availability, lastError: this.lastError, accountStatus: this.accountStatus(),
      chatError: this.chatErrors.get(chat) || null,
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
    if (['waiting-idle', 'switching', 'error'].includes(this.accountStatus()?.phase) ||
        chat.actor.accountKey && (this.accountId !== actor.accountId || this.accountKey !== chat.actor.accountKey)) {
      throw new Error('The selected account changed. Your message remains in the draft.');
    }
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
    delete chat.armForTurn;
    if (!chat.autoContinue) chat.autoPending = null;
    else try {
      const current = await this.readThread(actor);
      const turn = latestTurn(current);
      chat.autoIgnoreTurnId = idle(current) ? turn.id : null;
      const goal = await this.readGoal(actor);
      this.chatErrors.delete(chat);
      // The switch enables monitoring. Only a verified usage interruption can queue work.
      if (chat.autoContinue && idle(current) && usageFailure(chat, turn, goal)) {
        if (this.accountId === actor.accountId && this.availability.known && !this.availability.ready) {
          this.markAuto(chat, turn.id, failureReason(turn, goal), goal);
        } else if (this.accountId !== actor.accountId || !this.availability.known) chat.armForTurn = turn.id;
      }
    } catch (error) {
      this.chatError(chat, error);
    }
    this.save();
    return this.snapshot(actor);
  }

  markAuto(chat, turnId, reason, goal) {
    if (!chat.autoContinue || chat.handled.includes(turnId) || chat.messages.some(message => ['queued', 'attempted'].includes(message.state))) return;
    if (goal && !['active', 'usageLimited'].includes(goal.status)) return;
    if (chat.autoPending?.turnId === turnId) return;
    chat.autoPending = { turnId, reason, state: 'queued', noticedAt: this.now(),
      action: goal ? 'resume-goal' : 'continue', ...(goal ? { goalKey: goal.key } : {}),
    };
  }

  chatError(chat, error) {
    if (this.chatErrors.get(chat) !== error.message) this.log('chat-check-failed', { threadId: chat.actor.threadId, error: error.message });
    this.chatErrors.set(chat, error.message);
  }

  discardAuto(chat) {
    if (chat.autoPending) chat.handled.push(chat.autoPending.turnId);
    chat.handled = chat.handled.slice(-100);
    chat.autoPending = null;
    this.save();
  }

  async observe(actor, { turnId, error, willRetry }) {
    if (willRetry || !usageError(error)) return;
    if (!turnId) return;
    const chat = this.chat(actor);
    const current = await this.readThread(actor);
    if (latestTurn(current).id !== turnId) return;
    chat.lastUsageFailure = { turnId, noticedAt: this.now() };
    this.save();
    if (chat.autoContinue && turnId !== chat.autoIgnoreTurnId) this.markAuto(chat, turnId, 'structured-usage-error', await this.readGoal(actor));
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

  prepareAccountSwitch(target) {
    if (!target?.accountId || !target.accountKey || !this.accountKey) throw new Error('The account handoff could not be verified.');
    if (this.state.accountHandoff?.fromKey === this.accountKey && this.state.accountHandoff?.toKey === target.accountKey) return;
    this.state.accountHandoff = { from: this.accountId, fromKey: this.accountKey,
      to: target.accountId, toKey: target.accountKey, preparedAt: this.now() };
    this.save();
  }

  finishAccountSwitch(reading) {
    const handoff = this.state.accountHandoff;
    if (!handoff) return;
    if (reading.accountId !== handoff.to || reading.accountKey !== handoff.toKey) {
      if (reading.accountId !== handoff.from || reading.accountKey !== handoff.fromKey) {
        delete this.state.accountHandoff; this.save();
      }
      return;
    }
    if (handoff.from !== handoff.to || handoff.fromKey !== handoff.toKey) {
      const source = this.accountChats(handoff.from, handoff.fromKey, false) || {};
      const target = this.accountChats(handoff.to, handoff.toKey);
      for (const [threadId, chat] of Object.entries(source)) {
        if (!chat.autoContinue && !chat.messages.some(item => item.state === 'queued')) continue;
        // An unacknowledged send stays with its original account for manual review.
        if (chat.autoPending?.state === 'attempted' || chat.messages.some(item => item.state === 'attempted')) continue;
        const existing = target[threadId];
        if (existing && (existing.autoContinue || existing.autoPending || existing.messages.some(item => ['queued', 'attempted'].includes(item.state)))) continue;
        const moved = JSON.parse(JSON.stringify(chat));
        moved.actor = { ...chat.actor, accountId: handoff.to, accountKey: handoff.toKey };
        moved.messages = moved.messages.filter(item => item.state === 'queued');
        target[threadId] = moved;
        chat.messages = chat.messages.filter(item => item.state !== 'queued');
        chat.autoPending = null; chat.autoContinue = false; delete chat.armForTurn;
      }
    }
    delete this.state.accountHandoff;
    this.save();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      let reading = await this.quota();
      if (!reading?.accountId) throw new Error('Quota account identity is unavailable.');
      this.finishAccountSwitch(reading);
      this.accountId = reading.accountId;
      this.accountKey = reading.accountKey || null;
      this.availability = quotaStatus(reading);
      this.lastError = null;
      const chats = Object.values(this.accountChats(this.accountId, this.accountKey, false) || {});
      for (const chat of chats) {
        try {
          await this.processChat(chat);
          if (this.chatErrors.delete(chat)) this.log('chat-check-recovered', { threadId: chat.actor.threadId });
        } catch (error) { this.chatError(chat, error); }
      }
      if (this.availability.known && !this.availability.ready) {
        reading = await this.switchAccount({ accountId: this.accountId, accountKey: this.accountKey,
          prepare: target => this.prepareAccountSwitch(target) });
        if (reading) {
          this.finishAccountSwitch(reading);
          this.accountId = reading.accountId; this.accountKey = reading.accountKey || null;
          this.availability = quotaStatus(reading);
          for (const chat of Object.values(this.accountChats(this.accountId, this.accountKey, false) || {})) {
            try { await this.processChat(chat); this.chatErrors.delete(chat); }
            catch (error) { this.chatError(chat, error); }
          }
        }
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
    const goal = chat.autoContinue ? await this.readGoal(chat.actor) : null;
    if (chat.autoPending?.state === 'queued' && !usageFailure(chat, turn, goal)) {
      // Drop unproven entries created by the old toggle, without touching typed messages.
      chat.autoPending = null;
      if (idle(current)) chat.autoIgnoreTurnId = turn.id;
      this.save();
    }
    if (this.startupChats.delete(chat) && !chat.autoPending && !chat.messages.some(message => ['queued', 'attempted'].includes(message.state)) && idle(current)) {
      chat.autoIgnoreTurnId = turn.id;
      this.save();
    }
    if (chat.armForTurn && this.availability.known) {
      if (chat.armForTurn === turn.id && !this.availability.ready && usageFailure(chat, turn, goal)) this.markAuto(chat, turn.id, failureReason(turn, goal), goal);
      delete chat.armForTurn;
      this.save();
    }
    if (chat.autoContinue && turn.id !== chat.autoIgnoreTurnId && usageFailure(chat, turn, goal)) {
      this.markAuto(chat, turn.id, failureReason(turn, goal), goal);
      this.save();
    }
    if (chat.autoPending && chat.autoPending.turnId !== turn.id) { chat.autoPending = null; this.save(); }
    if (chat.autoPending?.state === 'queued') {
      const pending = chat.autoPending;
      if (pending.action === 'resume-goal' && (!goal || goal.key !== pending.goalKey) ||
          goal && !['active', 'usageLimited'].includes(goal.status) ||
          goal?.status === 'active' && this.availability.ready) {
        this.discardAuto(chat);
      } else if (goal && pending.action !== 'resume-goal') {
        // Upgrade a continuation saved by older versions without sending a prompt.
        pending.action = 'resume-goal'; pending.goalKey = goal.key; this.save();
      }
    }
    if (!idle(current) || !this.availability.ready) return;
    if (chat.messages.some(message => message.state === 'attempted') || chat.autoPending?.state === 'attempted') return;
    const message = chat.messages.find(message => message.state === 'queued');
    const automatic = !message && chat.autoContinue && chat.autoPending?.state === 'queued' ? chat.autoPending : null;
    if (!message && !automatic) return;
    if (automatic && chat.lastAutoAttemptAt && this.now() - chat.lastAutoAttemptAt < 300000) return;
    if (automatic?.action === 'resume-goal' && goal?.status !== 'usageLimited') return;
    const freshQuota = await this.quota();
    if (freshQuota.accountId !== chat.actor.accountId || chat.actor.accountKey && freshQuota.accountKey !== chat.actor.accountKey ||
        !quotaStatus(freshQuota).ready) return;
    const checked = await this.readThread(chat.actor);
    if (!idle(checked) || latestTurn(checked).id !== turn.id) return;
    if (automatic && automatic.turnId !== turn.id) return;
    if (automatic && (!chat.autoContinue || chat.autoPending !== automatic || chat.messages.some(message => message.state === 'queued'))) return;
    if (message && (!chat.messages.includes(message) || message.state !== 'queued')) return;
    const checkedGoal = automatic ? await this.readGoal(chat.actor) : null;
    if (automatic && (automatic.action === 'resume-goal'
      ? checkedGoal?.status !== 'usageLimited' || checkedGoal.key !== automatic.goalKey
      : checkedGoal !== null)) return;
    const autoAllowed = () => chat.autoContinue && chat.autoPending === automatic &&
      !chat.messages.some(message => message.state === 'queued');
    if (automatic && !autoAllowed()) return;
    const item = message || automatic;
    item.state = 'attempted'; item.attemptedAt = this.now(); chat.lastAttemptAt = this.now();
    if (automatic) { chat.lastAutoAttemptAt = this.now(); chat.handled.push(automatic.turnId); }
    this.save(); // Persist before submitting; an uncertain result must never be retried automatically.
    try {
      if (automatic?.action === 'resume-goal') {
        const result = await this.resumeGoal(chat.actor, checkedGoal, autoAllowed);
        if (!result?.resumed) { this.discardAuto(chat); return; }
      } else await this.send(chat.actor, message ? message.text : 'Continue');
      item.state = 'sent'; item.sentAt = this.now();
      if (automatic) { chat.autoPending = null; }
      else { chat.autoPending = null; }
      chat.handled = chat.handled.slice(-100);
      this.save();
      this.log(automatic?.action === 'resume-goal' ? 'goal-resumed' : 'message-sent', { threadId: chat.actor.threadId, id: message?.id || automatic.turnId, automatic: !!automatic });
    } catch (error) {
      this.save();
      const goalResume = automatic?.action === 'resume-goal';
      this.log(goalResume ? 'goal-resume-uncertain' : 'send-uncertain', { threadId: chat.actor.threadId, error: error.message });
      throw new Error(goalResume ? 'A goal resume was not acknowledged. Check this chat before resuming again.' : 'A send was not acknowledged. Check this chat before sending again.');
    }
  }
}

module.exports = { QueueEngine, quotaStatus, usageError, latestTurn, idle };
