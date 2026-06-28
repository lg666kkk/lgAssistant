const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const isDev = process.argv.includes("--dev") || !app.isPackaged;
const port = Number(process.env.PORT || (isDev ? 3000 : 31317));
const host = "127.0.0.1";
const appUrl = `http://${host}:${port}`;

let nextProcess = null;
let mainWindow = null;

let logStream = null;
function debugLog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    if (!logStream) {
      const logPath = path.join(app.getPath("userData"), "desktop.log");
      logStream = fs.createWriteStream(logPath, { flags: "a" });
      logStream.write(`\n=== launch isDev=${isDev} packaged=${app.isPackaged} appPath=${app.getAppPath()} ===\n`);
    }
    logStream.write(line);
  } catch {}
  console.log(line.trimEnd());
}

function loadEnvFiles() {
  const dotenv = require("dotenv");
  const candidates = [
    path.join(process.cwd(), ".env.local"),
    path.join(path.dirname(process.execPath), ".env.local"),
    path.join(app.getPath("userData"), ".env.local"),
  ];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
    }
  }
}

function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", (error) => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(error);
          return;
        }
        setTimeout(check, 300);
      });

      request.setTimeout(1000, () => {
        request.destroy();
      });
    };

    check();
  });
}

function startNextDev() {
  const nextBin =
    process.platform === "win32"
      ? path.join(process.cwd(), "node_modules", ".bin", "next.cmd")
      : path.join(process.cwd(), "node_modules", ".bin", "next");

  nextProcess = spawn(nextBin, ["dev", "--hostname", host, "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: host,
      BROWSER: "none",
    },
    stdio: "inherit",
  });

  nextProcess.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`Next dev server exited with code ${code}`);
    }
  });
}

function startNextStandalone() {
  // The standalone server runs `process.chdir(__dirname)` and resolves its own
  // node_modules relative to its location, neither of which works inside an
  // asar archive. Packaging is therefore done with `asar: false` (see
  // package.json), and we launch the server as a real child process.
  const serverPath = path.join(app.getAppPath(), ".next", "standalone", "server.js");
  debugLog("startNextStandalone serverPath=", serverPath, "exists=", String(fs.existsSync(serverPath)));
  debugLog("execPath=", process.execPath);

  nextProcess = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      // Run the Electron binary as plain Node so we don't ship a separate node.
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: host,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  nextProcess.stdout.on("data", (d) => debugLog("[next stdout]", d.toString().trimEnd()));
  nextProcess.stderr.on("data", (d) => debugLog("[next stderr]", d.toString().trimEnd()));
  nextProcess.on("error", (err) => debugLog("[next spawn error]", err.message));
  nextProcess.on("exit", (code, signal) => {
    debugLog(`[next exit] code=${code} signal=${signal}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: "Personal Assistant",
    backgroundColor: "#020617",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(appUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  loadEnvFiles();

  if (isDev) {
    startNextDev();
  } else {
    startNextStandalone();
  }

  try {
    await waitForServer(appUrl);
  } catch (error) {
    console.error("Next server did not start in time:", error);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (nextProcess && !nextProcess.killed) {
    nextProcess.kill();
  }
});
