'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { QueueEngine } = require('./engine.cjs');
const { readQuota, withTools } = require('./transport.cjs');

module.exports.install = function install({ app, ipcMain, webContents }) {
  let engine, timer, disposed = false, notification;
  const ready = app.whenReady().then(() => {
    const directory = path.join(app.getPath('userData'), 'quota-queue');
    fs.mkdirSync(directory, { recursive: true });
    const log = (event, details) => {
      fs.appendFileSync(path.join(directory, 'queue.log'), JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n');
    };
    const changed = () => {
      if (notification || disposed) return;
      notification = setTimeout(() => {
        notification = null;
        for (const view of webContents.getAllWebContents()) {
          if (!view.isDestroyed() && /^(app:|file:)/.test(view.getURL())) view.send('codex-quota-queue:updated');
        }
      }, 50);
    };
    engine = new QueueEngine({
      stateFile: path.join(directory, 'state.json'), changed, log,
      quota: () => readQuota(process.resourcesPath),
      readThread: actor => withTools(actor, 'read_thread', {
        threadId: actor.threadId, hostId: actor.hostId, turnLimit: 1,
        includeOutputs: false, maxOutputCharsPerItem: 0,
      }),
      send: (actor, text) => withTools(actor, 'send_message_to_thread', {
        threadId: actor.threadId, hostId: actor.hostId, prompt: text,
      }),
    });
    timer = setInterval(() => engine.tick(), 30000);
    timer.unref();
    engine.tick();
  });
  ready.catch(error => console.error('Quota queue could not start:', error.message));
  ipcMain.handle('codex-quota-queue:command', async (event, command, payload) => {
    if (event.senderFrame !== event.sender.mainFrame || !/^(app:|file:)/.test(event.senderFrame.url)) {
      throw new Error('Queue commands are only available in the Codex chat window.');
    }
    await ready;
    const actor = payload?.actor;
    engine.chat(actor, false);
    switch (command) {
      case 'status': return engine.snapshot(actor);
      case 'enqueue': {
        const result = await engine.enqueue(actor, payload.text, payload.requestId);
        setImmediate(() => engine.tick());
        return result;
      }
      case 'preference': return engine.preference(actor, payload.enabled);
      case 'cancel': return engine.cancel(actor, payload.id);
      case 'cancel-auto': return engine.cancelAuto(actor, payload.id);
      case 'review': return engine.review(actor, payload.id);
      case 'observe': {
        await engine.observe(actor, payload.observation);
        setImmediate(() => engine.tick());
        return engine.snapshot(actor);
      }
      default: throw new Error('Unknown queue command.');
    }
  });
  app.once('before-quit', () => { disposed = true; clearInterval(timer); clearTimeout(notification); });
};
