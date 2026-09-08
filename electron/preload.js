const { contextBridge, ipcRenderer } = require('electron');

// The same function the write path uses, so the source view can show what a
// save would actually put on disk instead of its own approximation.
const { breakBlocks } = require('./document');

contextBridge.exposeInMainWorld('csNote', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  chooseBookDir: () => ipcRenderer.invoke('book:chooseDir'),
  listBooks: () => ipcRenderer.invoke('book:list'),
  selectBook: (index) => ipcRenderer.invoke('book:select', index),
  saveBook: (payload) => ipcRenderer.invoke('book:save', payload),
  removeBook: (index) => ipcRenderer.invoke('book:remove', index),
  reorderBooks: (payload) => ipcRenderer.invoke('book:reorder', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  getTree: () => ipcRenderer.invoke('book:getTree'),
  readNote: (relativePath) => ipcRenderer.invoke('note:read', relativePath),
  writeNote: (payload) => ipcRenderer.invoke('note:write', payload),
  breakBlocks: (bodyInner) => breakBlocks(bodyInner),
  createNote: (payload) => ipcRenderer.invoke('note:create', payload),
  createFolder: (payload) => ipcRenderer.invoke('folder:create', payload),
  describeFolder: (payload) => ipcRenderer.invoke('folder:describe', payload),
  renameItem: (payload) => ipcRenderer.invoke('item:rename', payload),
  deleteItem: (payload) => ipcRenderer.invoke('item:delete', payload),
  moveItem: (payload) => ipcRenderer.invoke('item:move', payload),
  saveImage: (payload) => ipcRenderer.invoke('image:save', payload),
  searchNotes: (payload) => ipcRenderer.invoke('search:notes', payload),
  showInFolder: (relativePath) => ipcRenderer.invoke('shell:showItem', relativePath),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  listTemplates: () => ipcRenderer.invoke('template:list'),

  // The window will not close until the renderer answers with flushComplete(),
  // so a pending autosave is written instead of thrown away.
  onFlushRequest: (handler) => ipcRenderer.on('app:flush', () => handler()),
  flushComplete: (proceed = true) => ipcRenderer.send('app:flushed', proceed),
  // Asking the user takes as long as it takes. This stops the close deadline
  // so a dialog is not answered by the window vanishing.
  flushHold: () => ipcRenderer.send('app:flush-hold'),

  // The renderer is told a version number and nothing else; where the button
  // goes is decided in the main process.
  onUpdateAvailable: (handler) => ipcRenderer.on('app:update', (_e, found) => handler(found)),
  openReleases: () => ipcRenderer.invoke('app:openReleases'),

  // Files a note carries. A note path and a file name cross here, never a
  // path of our own making: the main process resolves every one of them.
  listAttachments: (payload) => ipcRenderer.invoke('attach:list', payload),
  addAttachments: (payload) => ipcRenderer.invoke('attach:add', payload),
  removeAttachment: (payload) => ipcRenderer.invoke('attach:remove', payload),
  openAttachment: (payload) => ipcRenderer.invoke('attach:open', payload),
  attachmentRef: (payload) => ipcRenderer.invoke('attach:ref', payload),
});
