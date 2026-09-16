// MicMatch - processo main Electron
//
// Responsabilita': finestra dell'app, dialog nativi di selezione file,
// e IPC verso python/mic_match.py (stesso protocollo stdin/stdout JSON
// PROGRESS:/RESULT:/ERROR: usato in ADR Studio Suite).

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const AUDIO_EXTENSIONS = ["wav", "aiff", "aif", "flac", "mp3", "m4a", "caf"];

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 820,
    minHeight: 600,
    title: "MicMatch",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Inoltra gli errori/log della console del renderer sul terminale: utile
  // in sviluppo per accorgersi subito di errori JS lato UI senza dover
  // aprire i DevTools a mano.
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });
}

app.whenReady().then(() => {
  // In dev (npm start) l'icona del Dock su macOS resta quella generica di
  // Electron a meno di impostarla esplicitamente qui - il "icon" passato a
  // BrowserWindow sopra riguarda soprattutto Windows/Linux. Da pacchetto
  // l'icona del Dock e' invece quella del bundle (vedi "icon" in
  // package.json/build), questa chiamata non serve e viene ignorata.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    app.dock.setIcon(path.join(__dirname, "build", "icon.png"));
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------------------------------------------------------------------------
// Risoluzione percorsi: dev vs app impacchettata
// ---------------------------------------------------------------------------
//
// python/ (script + requirements.txt) e python-runtime/ (interprete
// autonomo, vedi sotto) sono dichiarati "extraResources" in package.json:
// finiscono copiati per davvero accanto all'asar (Contents/Resources/...),
// non dentro - a differenza di "files", che li avrebbe messi nell'archivio
// asar, illeggibile da child_process.spawn() (ENOTDIR, bug segnalato
// dall'utente dopo il primo build). getScriptsDir()/getRuntimeDir()
// costruiscono il percorso giusto sia in dev sia da pacchetto, stesso
// pattern di ADR Studio Suite (vedi la sua getScriptsDir() in main.js).

function getScriptsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python");
  }
  return path.join(__dirname, "python");
}

function getRuntimeDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python-runtime");
  }
  return path.join(__dirname, "python-runtime");
}

// ---------------------------------------------------------------------------
// Risoluzione interprete Python
// ---------------------------------------------------------------------------

function resolvePythonExecutable() {
  const runtimeDir = getRuntimeDir();

  // Priorita' 1: python-runtime/ - interprete AUTONOMO (python-build-
  // standalone) spedito con l'app, prodotto da
  // scripts/setup-python-runtime.js. E' l'unico che funzioni su una
  // macchina che non abbia gia' Python con le dipendenze giuste installate
  // - vedi i commenti in quello script per il perche' un venv non basta.
  const standalonePython =
    process.platform === "win32"
      ? path.join(runtimeDir, "python.exe")
      : path.join(runtimeDir, "bin", "python3");
  if (fs.existsSync(standalonePython)) {
    return standalonePython;
  }

  // Priorita' 2: python/venv - il venv di sviluppo (comodo mentre si
  // lavora sul codice: niente da ricostruire ad ogni modifica). Funziona
  // solo su questa macchina, non e' distribuibile - per questo e' escluso
  // dal pacchetto (vedi package.json).
  const venvDir = path.join(getScriptsDir(), "venv");
  const venvCandidates =
    process.platform === "win32"
      ? [path.join(venvDir, "Scripts", "python.exe")]
      : [path.join(venvDir, "bin", "python3"), path.join(venvDir, "bin", "python")];
  for (const candidate of venvCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (process.platform !== "win32") {
    // Priorita' 3: percorsi assoluti noti del Python di sistema. Un'app
    // lanciata con doppio click (o `open`) da Finder/Launchpad NON eredita
    // il PATH della shell interattiva (quello impostato da .zshrc/
    // .zprofile, che di solito include /opt/homebrew/bin): riceve solo il
    // PATH minimo di macOS, quindi un semplice "python3" affidato al PATH
    // (l'ultima spiaggia qui sotto) puo' risolvere un interprete diverso
    // da quello con le dipendenze installate, o nessuno (bug osservato
    // durante lo sviluppo). Con python-runtime/ impacchettato questo caso
    // non dovrebbe piu' presentarsi in produzione - resta come rete di
    // sicurezza per chi lancia da sorgente senza aver fatto il setup.
    const systemCandidates = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
    for (const candidate of systemCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Ultima spiaggia: risoluzione via PATH del processo.
  return process.platform === "win32" ? "python" : "python3";
}

// ---------------------------------------------------------------------------
// Esecuzione script Python con protocollo PROGRESS:/RESULT:/ERROR:
// ---------------------------------------------------------------------------

function runPythonAction(action, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const pythonExe = resolvePythonExecutable();
    const scriptPath = path.join(getScriptsDir(), "mic_match.py");
    const child = spawn(pythonExe, [scriptPath], {
      cwd: getScriptsDir(),
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Impossibile avviare Python (${pythonExe}): ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      // Il processo e' morto prima di passare da emit_error() (es. errore di
      // import a livello di modulo, prima che il nostro try/except in main()
      // possa intervenire): niente messaggio amichevole gia' pronto, quindi
      // ne mettiamo uno generico qui e teniamo lo stderr grezzo come dettaglio.
      const error = new Error(
        code !== 0
          ? "Il motore di elaborazione si e' interrotto in modo imprevisto."
          : "Il motore di elaborazione non ha restituito alcun risultato."
      );
      error.details = stderrBuffer || `mic_match.py terminato con codice ${code}`;
      reject(error);
    });

    function handleLine(line) {
      if (!line.trim()) return;
      if (line.startsWith("PROGRESS:")) {
        try {
          const data = JSON.parse(line.slice("PROGRESS:".length));
          if (onProgress) onProgress(data);
        } catch (_) {
          /* ignora righe di progress malformate */
        }
      } else if (line.startsWith("RESULT:")) {
        try {
          const data = JSON.parse(line.slice("RESULT:".length));
          settled = true;
          resolve(data);
        } catch (err) {
          settled = true;
          reject(new Error(`RESULT JSON non valido: ${err.message}`));
        }
      } else if (line.startsWith("ERROR:")) {
        try {
          const data = JSON.parse(line.slice("ERROR:".length));
          settled = true;
          const error = new Error(data.message || "Errore sconosciuto nello script Python");
          error.details = data.details || "";
          reject(error);
        } catch (err) {
          settled = true;
          reject(new Error(`ERROR JSON non valido: ${err.message}`));
        }
      }
    }

    child.stdin.write(JSON.stringify({ action, ...payload }) + "\n");
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// IPC: dialog nativi
// ---------------------------------------------------------------------------

ipcMain.handle("dialog:selectReference", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Seleziona la traccia di riferimento",
    properties: ["openFile"],
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:selectTargets", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Seleziona le tracce da adattare",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle("dialog:selectOutputDir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Cartella di destinazione",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("shell:reveal", (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle("app:quit", () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// IPC: motore DSP
// ---------------------------------------------------------------------------

ipcMain.handle("mic-match:analyze", async (_event, filePath) => {
  return runPythonAction("analyze", { path: filePath });
});

ipcMain.handle("mic-match:listMicProfiles", async () => {
  return runPythonAction("list_mic_profiles", {});
});

ipcMain.handle("mic-match:micProfileSpectrum", async (_event, { profileId, numBands }) => {
  return runPythonAction("mic_profile_spectrum", { profile_id: profileId, num_bands: numBands });
});

ipcMain.handle(
  "mic-match:process",
  async (event, { referenceMode, referencePath, micProfile, targetPaths, outputDir, config }) => {
    const resolvedOutputDir = outputDir || path.join(path.dirname(targetPaths[0]), "matched");
    return runPythonAction(
      "match",
      {
        reference_mode: referenceMode || "track",
        reference_path: referencePath,
        mic_profile: micProfile,
        target_paths: targetPaths,
        output_dir: resolvedOutputDir,
        config,
      },
      (progress) => {
        event.sender.send("mic-match:progress", progress);
      }
    );
  }
);
