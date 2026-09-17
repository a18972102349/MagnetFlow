const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (name, ...args) => {
  const result = await ipcRenderer.invoke(name, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const subscribe = (name, listener) => {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(name, handler);
  return () => ipcRenderer.removeListener(name, handler);
};
contextBridge.exposeInMainWorld('magnetFlow', {
  state: () => invoke('state'), add: magnet => invoke('add', magnet), importTorrent: () => invoke('import'),
  searchSettings: () => invoke('search-settings'), saveSearchSource: input => invoke('save-search-source', input), removeSearchSource: id => invoke('remove-search-source', id),
  searchResources: input => invoke('search-resources', input), cancelResourceSearch: id => invoke('cancel-resource-search', id), addSearchResult: id => invoke('add-search-result', id),
  onSearchProgress: listener => subscribe('search-progress', listener),
  pause: id => invoke('pause', id), resume: id => invoke('resume', id), remove: id => invoke('remove', id),
  select: (id, indexes) => invoke('select', id, indexes), folder: id => invoke('folder', id),
  chooseDirectory: () => invoke('choose-directory'), limits: values => invoke('limits', values), choosePlayer: () => invoke('choose-player'),
  stream: (id, index, options) => invoke('stream', id, index, options), externalPlayer: (id, index) => invoke('external-player', id, index),
  networkSettings: updates => invoke('network-settings', updates), reannounce: id => invoke('reannounce', id), cancelPlayback: id => invoke('cancel-playback', id),
  onUpdate: listener => subscribe('update', listener), onNotice: listener => subscribe('notice', listener), onInvalidate: listener => subscribe('invalidate', listener)
});
