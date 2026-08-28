const { contextBridge, ipcRenderer, webUtils } = require('electron')
const e2eMode = process.argv.includes('--tugo-e2e-renderer')

contextBridge.exposeInMainWorld('tugo', {
  config: {
    read: () => ipcRenderer.invoke('tugo:config:read'),
    write: (value) => ipcRenderer.invoke('tugo:config:write', value),
  },
  folders: {
    list: () => ipcRenderer.invoke('tugo:folders:list'),
    create: (name) => ipcRenderer.invoke('tugo:folders:create', name),
    rename: (id, name) => ipcRenderer.invoke('tugo:folders:rename', { id, name }),
    remove: (id) => ipcRenderer.invoke('tugo:folders:remove', id),
  },
  projects: {
    list: () => ipcRenderer.invoke('tugo:projects:list'),
    get: (id) => ipcRenderer.invoke('tugo:projects:get', id),
    create: (payload) => ipcRenderer.invoke('tugo:projects:create', payload),
    update: (payload) => ipcRenderer.invoke('tugo:projects:update', payload),
    remove: (id) => ipcRenderer.invoke('tugo:projects:remove', id),
    snapshots: {
      create: (payload) => ipcRenderer.invoke('tugo:projects:snapshots:create', payload),
      list: (projectId, page, pageSize, source) => ipcRenderer.invoke('tugo:projects:snapshots:list', { projectId, page, pageSize, source }),
      get: (projectId, snapshotId) => ipcRenderer.invoke('tugo:projects:snapshots:get', { projectId, snapshotId }),
      export: (projectId, snapshotId) => ipcRenderer.invoke('tugo:projects:snapshots:export', { projectId, snapshotId }),
      import: (projectId, file) => ipcRenderer.invoke('tugo:projects:snapshots:import', { projectId, path: file ? webUtils.getPathForFile(file) : '' }),
      latest: (projectId) => ipcRenderer.invoke('tugo:projects:snapshots:latest', projectId),
      remove: (projectId, snapshotId) => ipcRenderer.invoke('tugo:projects:snapshots:remove', { projectId, snapshotId }),
    },
    skillScope: (projectId) => ipcRenderer.invoke('tugo:projects:skills:get', projectId),
    setSkillIds: (projectId, skillIds) => ipcRenderer.invoke('tugo:projects:skills:set', { projectId, skillIds }),
  },
  conversations: {
    list: () => ipcRenderer.invoke('tugo:conversations:list'),
    create: (projectId) => ipcRenderer.invoke('tugo:conversations:create', projectId),
    save: (value) => ipcRenderer.invoke('tugo:conversations:save', value),
    activate: (projectId, conversationId) => ipcRenderer.invoke('tugo:conversations:activate', { projectId, conversationId }),
    removeForProject: (projectId) => ipcRenderer.invoke('tugo:conversations:remove-for-project', projectId),
  },
  board: {
    onToolCall: (callback) => {
      const listener = (_, payload) => callback(payload)
      ipcRenderer.on('tugo:board-tool-call', listener)
      return () => ipcRenderer.removeListener('tugo:board-tool-call', listener)
    },
    respondToolCall: (id, result, error) => ipcRenderer.send('tugo:board-tool-result', { id, result, error }),
  },
  runtime: {
    request: (method, params) => ipcRenderer.invoke('tugo:runtime:request', method, params),
    onEvent: (callback) => {
      const listener = (_, payload) => callback(payload)
      ipcRenderer.on('tugo:runtime-event', listener)
      return () => ipcRenderer.removeListener('tugo:runtime-event', listener)
    },
    onStreamEnd: (callback) => {
      const listener = (_, payload) => callback(payload)
      ipcRenderer.on('tugo:runtime-stream-end', listener)
      return () => ipcRenderer.removeListener('tugo:runtime-stream-end', listener)
    },
  },
  system: {
    appName: () => ipcRenderer.invoke('tugo:system:app-name'),
    backendLog: () => ipcRenderer.invoke('tugo:system:backend-log'),
    chooseAttachments: () => ipcRenderer.invoke('tugo:system:choose-attachments'),
    chooseSkill: () => ipcRenderer.invoke('tugo:system:choose-skill'),
    // Electron 32+ intentionally no longer exposes File.path in the renderer.
    // Keep the privileged conversion here, rather than allowing renderer code
    // any general filesystem access.
    getPathForFile: (file) => webUtils.getPathForFile(file),
    openDataDirectory: () => ipcRenderer.invoke('tugo:system:open-data-directory'),
    openBackendLog: () => ipcRenderer.invoke('tugo:system:open-backend-log'),
    openDownloadedFile: (path) => ipcRenderer.invoke('tugo:system:open-downloaded-file', path),
    onDownloadState: (callback) => {
      const listener = (_, payload) => callback(payload)
      ipcRenderer.on('tugo:download-state', listener)
      return () => ipcRenderer.removeListener('tugo:download-state', listener)
    },
    // This bridge exists only in isolated Electron E2E launches. It lets the
    // renderer exercise the same download-state subscription used by the
    // native `will-download` handler without exposing a production IPC route.
    ...(e2eMode ? { e2eEmitDownload: (state) => ipcRenderer.invoke('tugo:e2e:emit-download', state) } : {}),
  },
  data: {
    status: () => ipcRenderer.invoke('tugo:data:status'),
    backup: () => ipcRenderer.invoke('tugo:data:backup'),
    exportPackage: (kind) => ipcRenderer.invoke('tugo:data:export-package', kind),
    restore: (scope, name) => ipcRenderer.invoke('tugo:data:restore', { scope, name }),
  },
})
