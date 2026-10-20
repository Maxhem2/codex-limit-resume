;(() => {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('codexQuotaQueueBridge', {
    command: (command, payload) => ipcRenderer.invoke('codex-quota-queue:command', command, payload),
    subscribe: callback => {
      const listener = () => callback();
      ipcRenderer.on('codex-quota-queue:updated', listener);
      return () => ipcRenderer.removeListener('codex-quota-queue:updated', listener);
    },
  });
})();
