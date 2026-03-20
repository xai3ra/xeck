const { app, BrowserWindow, dialog, Menu, shell, Notification } = require('electron');
if (process.platform === 'win32') app.setAppUserModelId('com.xeck.app');
Menu.setApplicationMenu(null);
const path = require('path');
// Set data directory to a writable location for the packaged app
// This must be set BEFORE requiring ./server
process.env.XECK_DATA_DIR = app.getPath('userData');

// Polyfill for DOMMatrix which is missing in Node context but required by some dependencies
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {
    constructor() {
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
    }
  };
}
const { autoUpdater } = require('electron-updater');
const { server, authBus, updateBus, setUpdateProgress } = require('./server');

// Handle manual update check from UI
if (updateBus) {
  updateBus.on('check-update', (callback) => {
    autoUpdater.checkForUpdates()
      .then(result => {
        const currentVersion = app.getVersion();
        const latestVersion = result.updateInfo.version;
        console.log(`[Update] Manual check: Current=${currentVersion}, Latest=${latestVersion}`);
        if (latestVersion !== currentVersion) {
            callback({ updateAvailable: true, version: latestVersion });
        } else {
            callback({ updateAvailable: false });
        }
      })
      .catch(err => {
        console.error('[Update] Manual check error:', err);
        callback({ error: err.message });
      });
  });
}

// Focus application when authentication succeeds
if (authBus) {
  authBus.on('authenticated', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.setVisibleOnAllWorkspaces(true); // Jump workspaces if needed
      mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      mainWindow.focus();
      // Brief delay before removing AlwaysOnTop to ensure OS grants focus
      setTimeout(() => {
        if (mainWindow) {
            mainWindow.setAlwaysOnTop(false);
            mainWindow.setVisibleOnAllWorkspaces(false);
        }
      }, 500);
    }
  });
}

let mainWindow;

// Configure logging for autoUpdater
autoUpdater.logger = console;
autoUpdater.autoDownload = false; // We will ask the user before downloading

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Open Google OAuth in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://accounts.google.com/')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(`http://localhost:${port}`);
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Removed checkForUpdatesAndNotify to allow frontend to control updates
  // mainWindow.once('ready-to-show', () => { autoUpdater.checkForUpdatesAndNotify(); });
}

// Update events
updateBus.on('start-update', () => {
    setUpdateProgress({ status: 'downloading', percent: 0 });
    autoUpdater.downloadUpdate();
});

updateBus.on('install-update', () => {
    // Attempt graceful restart for NSIS installer
    if (mainWindow) mainWindow.close();
    setImmediate(() => {
        app.removeAllListeners('window-all-closed');
        autoUpdater.quitAndInstall(true, true);
    });
});

autoUpdater.on('update-available', (info) => {
  // Silent: UI handles it via API checking
  console.log('[Updater] Update Available:', info.version);
});

autoUpdater.on('download-progress', (progressObj) => {
  setUpdateProgress({
    status: 'downloading',
    percent: Math.floor(progressObj.percent),
    bytesPerSecond: progressObj.bytesPerSecond,
    transferred: progressObj.transferred,
    total: progressObj.total
  });
});

autoUpdater.on('update-downloaded', (info) => {
  setUpdateProgress({ status: 'ready', percent: 100 });
  // Silent: UI handles prompting user to restart
});


autoUpdater.on('error', (err) => {
  console.error('Auto-update error:', err);
  setUpdateProgress({ status: 'error', error: err.message });
});


updateBus.on('show-notification', ({ title, body }) => {
    if (Notification.isSupported()) {
        new Notification({ title, body }).show();
    }
});

app.on('ready', () => {
  // The server auto-starts on port 0 in server.js
  const port = server.address().port;
  console.log(`Electron loading app on dynamic port: ${port}`);
  createWindow(port);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    const port = server.address().port;
    createWindow(port);
  }
});
