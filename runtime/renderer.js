;(() => {
  'use strict';
  const contexts = new Map();
  const observed = new Set();
  const bridge = () => window.codexQuotaQueueBridge;
  const actorKey = actor => `${actor.accountId}/${actor.hostId}/${actor.threadId}`;
  const supported = binding => binding?.kind === 'local' && binding.hostId === 'local' && binding.threadId && binding.accountId && bridge();
  const limited = state => !!(state?.accountMatches && state.quota?.known && !state.quota.ready);
  const command = (context, name, extra = {}) => bridge().command(name, { actor: context.actor, ...extra });

  function publish(context, state) {
    context.snapshot = state;
    for (const listener of context.listeners) listener(state);
  }

  async function refresh(context) {
    if (context.refreshing) return context.refreshing;
    context.refreshing = command(context, 'status').then(state => publish(context, state)).catch(error => {
      context.error = error;
    }).finally(() => { context.refreshing = null; });
    return context.refreshing;
  }

  function contextFor(binding) {
    if (!supported(binding)) return null;
    const actor = { threadId: binding.threadId, hostId: binding.hostId, accountId: binding.accountId };
    const key = actorKey(actor);
    let context = contexts.get(key);
    if (!context) {
      context = { actor, listeners: new Set(), snapshot: null, binding };
      contexts.set(key, context);
    }
    if (binding.controller) context.binding = binding;
    return context;
  }

  function useSnapshot(React, context) {
    const [entry, setEntry] = React.useState(() => ({ context, state: context?.snapshot }));
    React.useEffect(() => {
      if (!context) return;
      const listener = state => setEntry({ context, state });
      context.listeners.add(listener);
      listener(context.snapshot);
      refresh(context);
      return () => context.listeners.delete(listener);
    }, [context]);
    return entry.context === context ? entry.state : context?.snapshot;
  }

  function report(context, error) {
    context.error = error;
    if (context.binding.onError) context.binding.onError(error);
    else console.error('Quota queue:', error.message);
  }

  function rowStatus(state, attempted) {
    if (attempted) return 'Check chat';
    if (!state.accountMatches) return 'Account changed';
    if (!state.quota?.known || state.lastError) return 'Waiting for connection';
    if (!state.quota.ready) {
      const now = new Date();
      const resets = [state.quota.primary, state.quota.secondary].flatMap((window, index) => {
        if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 100) return [];
        const minutes = window.windowDurationMins ?? window.windowMinutes;
        const name = minutes >= 10080 || minutes == null && index === 1 ? 'weekly' : '5h';
        if (!Number.isFinite(window.resetsAt) || window.resetsAt <= 0) return [`${name} reset`];
        const date = new Date(window.resetsAt * 1000);
        const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
        const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
        const calendar = sameDay ? '' : ` (${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })})`;
        return [`${name} reset at ${time}${calendar}`];
      });
      return resets.length ? `Waiting for ${resets.join('\n')}` : 'Waiting for usage reset';
    }
    return 'Sending when idle';
  }

  function nativeMessages(context, state) {
    if (!context || !state) return [];
    const rows = state.messages.map(message => ({ ...message, automatic: false }));
    if (state.autoPending) rows.push({
      id: state.autoPending.turnId, text: 'Continue', state: state.autoPending.state, automatic: true,
    });
    return rows.map(message => ({
      id: `quota-queue:${message.automatic ? 'auto:' : ''}${message.id}`,
      text: message.text,
      context: { imageAttachments: [], fileAttachments: [], addedFiles: [] },
      canSendNow: false,
      pausedReason: message.state === 'attempted' ? 'quota-queue-unconfirmed' : null,
      submission: { status: message.state === 'attempted' ? 'outcome-unknown' : 'queued' },
      quotaQueue: {
        id: message.id, automatic: message.automatic, state: message.state,
        label: rowStatus(state, message.state === 'attempted'),
      },
    }));
  }

  async function remove(context, item) {
    const name = item.state === 'attempted' ? 'review' : item.automatic ? 'cancel-auto' : 'cancel';
    publish(context, await command(context, name, { id: item.id }));
  }

  function Toggle({ React, context, components }) {
    const state = useSnapshot(React, context);
    const [saving, setSaving] = React.useState(false);
    const enabled = state?.autoContinue === true;
    const title = `Auto-continue after reset: ${enabled ? 'on' : 'off'}`;
    const change = async () => {
      if (saving || !state) return;
      setSaving(true);
      try { publish(context, await command(context, 'preference', { enabled: !enabled })); }
      catch (error) { report(context, error); }
      finally { setSaving(false); }
    };
    const button = React.createElement(components.Button, {
      uniform: true, size: 'composer', color: enabled ? 'ghostActive' : 'ghost',
      className: enabled ? 'bg-primary-ghost-hover text-default' : undefined,
      'aria-label': 'Auto-continue after reset', 'aria-pressed': enabled,
      disabled: saving || !state, onClick: change,
      'data-quota-queue-toggle': '',
    }, React.createElement(components.Icon, { className: 'icon-sm', 'aria-hidden': true }));
    return React.createElement('span', { className: 'me-1 flex items-center' },
      React.createElement(components.Tooltip, { tooltipContent: title }, button));
  }

  globalThis.codexQuotaQueue = {
    useQuotaGate(React, binding, nativeQuotaBlocked) {
      const context = contextFor(binding);
      const state = useSnapshot(React, context);
      // This only replaces Codex's quota-specific guard. Other native submit guards remain intact.
      return nativeQuotaBlocked && !(state?.accountMatches && state.quota?.known);
    },
    useComposer(React, binding) {
      const context = contextFor(binding);
      const state = useSnapshot(React, context);
      return { context, state, messages: nativeMessages(context, state) };
    },
    queueProps(composer, original) {
      if (!composer?.messages.length) return original;
      const own = new Map(composer.messages.map(message => [message.id, message.quotaQueue]));
      return {
        ...original,
        messages: [...(original.messages || []), ...composer.messages],
        isReorderDisabled: true,
        isMessagePaused: reason => reason === 'quota-queue-unconfirmed' || original.isMessagePaused(reason),
        onDeleteMessage: id => {
          if (!own.has(id)) return original.onDeleteMessage(id);
          return remove(composer.context, own.get(id)).catch(error => report(composer.context, error));
        },
      };
    },
    withToggle(React, components, threadId, hostId, sendButton, controller) {
      const context = [...contexts.values()].find(context => context.actor.threadId === threadId &&
        context.actor.hostId === hostId && context.binding.controller === controller);
      if (!context) return sendButton;
      return React.createElement(React.Fragment, null,
        React.createElement(Toggle, { React, context, components, key: actorKey(context.actor) }), sendButton);
    },
    renderStatus(jsx, item) {
      return jsx.jsx('span', {
        className: 'text-xs text-tertiary text-right', role: 'status',
        style: { whiteSpace: 'pre-line', maxWidth: 'min(26rem, 55vw)' },
        ...(item.state === 'attempted' ? { title: 'Delivery is unconfirmed. Check the conversation before deleting this saved message.' } : {}),
        'data-quota-reset-status': '', children: item.label,
      });
    },
    async submitIfLimited(threadId, hostId, text) {
      const context = [...contexts.values()].find(context => context.actor.threadId === threadId &&
        context.actor.hostId === hostId && context.binding.controller?.view?.dom?.isConnected && context.listeners.size);
      if (!context || !limited(context.snapshot)) return false;
      if (context.saving) return true;
      if (context.binding.hasAttachments) throw new Error('Scheduling after a reset currently supports plain text. Your attachments remain in the draft.');
      if (!text?.trim()) return false;
      context.saving = true;
      if (context.retry?.text !== text) context.retry = { text, id: crypto.randomUUID() };
      try {
        const state = await command(context, 'enqueue', { text, requestId: context.retry.id });
        context.retry = null;
        publish(context, state);
        const controller = context.binding.controller;
        if (!controller.view.isDestroyed && controller.getText() === text) controller.setText('');
        return true;
      } finally { context.saving = false; }
    },
    observeError(observation) {
      const info = observation.error?.codexErrorInfo ?? observation.error?.codex_error_info;
      const names = typeof info === 'string' ? [info] : Object.keys(info || {});
      if (!names.some(name => name.replaceAll('_', '').toLowerCase() === 'usagelimitexceeded') || !observation.turnId || observation.willRetry) return;
      const context = [...contexts.values()].find(context => context.actor.threadId === observation.threadId &&
        (context.listeners.size || context.snapshot?.autoContinue === true));
      if (!context) return;
      const key = `${actorKey(context.actor)}/${observation.turnId}/${context.snapshot?.autoContinue}`;
      if (observed.has(key)) return;
      observed.add(key);
      queueMicrotask(async () => {
        try { publish(context, await command(context, 'observe', { observation })); }
        catch (error) { observed.delete(key); report(context, error); }
      });
    },
  };
  bridge()?.subscribe(() => {
    for (const context of contexts.values()) if (context.listeners.size) refresh(context);
  });
})();
