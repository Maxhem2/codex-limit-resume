'use strict';
const { createHash } = require('node:crypto');

function goalSnapshot(goal, threadId) {
  if (goal === null) return null;
  if (!goal || goal.threadId !== threadId || typeof goal.objective !== 'string' ||
      !Number.isFinite(goal.createdAt) || !Number.isFinite(goal.updatedAt) ||
      !['active', 'paused', 'usageLimited', 'blocked', 'budgetLimited', 'complete'].includes(goal.status)) {
    throw new Error('The native goal state could not be verified.');
  }
  return {
    key: createHash('sha256').update(JSON.stringify([goal.threadId, goal.createdAt, goal.objective])).digest('hex'),
    status: goal.status, updatedAt: goal.updatedAt,
  };
}

function createGoalAccess(getRegistry) {
  function connection(actor) {
    const client = actor.hostId === 'local' && getRegistry()?.getMaybeConnection(actor.hostId);
    if (!client) throw new Error('Waiting for the native Codex goal connection.');
    if (typeof client.sendAppServerRequest !== 'function') throw new Error('This Codex connection does not support native goal requests.');
    return client;
  }
  function assertCurrent(client, actor) {
    if (getRegistry()?.getMaybeConnection(actor.hostId) !== client) throw new Error('The native Codex goal connection changed.');
  }
  async function readFrom(client, actor) {
    let response;
    try {
      response = await client.sendAppServerRequest('thread/goal/get', { threadId: actor.threadId }, () => assertCurrent(client, actor));
      assertCurrent(client, actor);
    }
    catch (error) {
      if (error.message === 'goals feature is disabled') return null;
      throw error;
    }
    if (!response || !Object.hasOwn(response, 'goal')) throw new Error('The native goal query returned no result.');
    return goalSnapshot(response.goal, actor.threadId);
  }
  return {
    read: async actor => readFrom(connection(actor), actor),
    async resume(actor, expected, stillAllowed) {
      const client = connection(actor);
      const current = await readFrom(client, actor);
      if (!current || current.status !== 'usageLimited' || current.key !== expected.key ||
          current.updatedAt !== expected.updatedAt || !stillAllowed()) return { resumed: false };
      // This is the native Resume goal request. Keep the existing objective and budget.
      const cancelled = new Error('The pending goal resume was cancelled.');
      let response;
      try {
        response = await client.sendAppServerRequest('thread/goal/set', { threadId: actor.threadId, status: 'active' }, () => {
          assertCurrent(client, actor);
          if (!stillAllowed()) throw cancelled;
        });
      } catch (error) {
        if (error === cancelled) return { resumed: false };
        throw error;
      }
      const resumed = goalSnapshot(response?.goal, actor.threadId);
      if (!resumed || resumed.key !== expected.key || resumed.status !== 'active') {
        throw new Error('The native goal resume was not acknowledged.');
      }
      return { resumed: true };
    },
  };
}

module.exports = { createGoalAccess, goalSnapshot };
