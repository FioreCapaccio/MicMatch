// MicMatch - logica renderer (nessun accesso Node diretto: tutto passa da
// window.micMatchAPI esposto dal preload via contextBridge).

const AUDIO_EXTENSIONS = ["wav", "aiff", "aif", "flac", "mp3", "m4a", "caf"];

const state = {
  referenceMode: "track", // "track" | "mic_profile"
  referencePath: null,
  referenceSpectrum: null,
  micProfiles: [],
  micProfile: null,
  targetPaths: [],
  outputDir: null,
};

const els = {
  btnQuit: document.getElementById("btnQuit"),
  referencePanel: document.getElementById("referencePanel"),
  referenceModeToggle: document.getElementById("referenceModeToggle"),
  referenceTrackMode: document.getElementById("referenceTrackMode"),
  referenceMicMode: document.getElementById("referenceMicMode"),
  btnSelectReference: document.getElementById("btnSelectReference"),
  referenceInfo: document.getElementById("referenceInfo"),
  referenceAudio: document.getElementById("referenceAudio"),
  referenceSpectrumCanvas: document.getElementById("referenceSpectrum"),
  micProfileSelect: document.getElementById("micProfileSelect"),
  micProfileNote: document.getElementById("micProfileNote"),

  targetsPanel: document.getElementById("targetsPanel"),
  btnAddTargets: document.getElementById("btnAddTargets"),
  targetList: document.getElementById("targetList"),

  numBands: document.getElementById("numBands"),
  firTaps: document.getElementById("firTaps"),
  btnSelectOutput: document.getElementById("btnSelectOutput"),
  outputDirLabel: document.getElementById("outputDirLabel"),

  presetSelect: document.getElementById("presetSelect"),
  presetNameInput: document.getElementById("presetNameInput"),
  btnLoadPreset: document.getElementById("btnLoadPreset"),
  btnSavePreset: document.getElementById("btnSavePreset"),
  btnDeletePreset: document.getElementById("btnDeletePreset"),
  presetStatus: document.getElementById("presetStatus"),

  btnProcess: document.getElementById("btnProcess"),
  progressWrap: document.getElementById("progressWrap"),
  progressFill: document.getElementById("progressFill"),
  progressLabel: document.getElementById("progressLabel"),
  errorBox: document.getElementById("errorBox"),

  resultsList: document.getElementById("resultsList"),
};

// ---------------------------------------------------------------------------
// Knob di impostazione (vedi knob.js)
// ---------------------------------------------------------------------------

const knobs = {
  maxBoost: new MicMatchKnob(document.getElementById("knobMaxBoost"), {
    min: 0, max: 18, step: 0.5, value: 6, defaultValue: 6, unit: " dB", label: "Boost max/banda",
    onChange: () => scheduleSaveSession(),
  }),
  maxCut: new MicMatchKnob(document.getElementById("knobMaxCut"), {
    min: 0, max: 24, step: 0.5, value: 12, defaultValue: 12, unit: " dB", label: "Taglio max/banda",
    onChange: () => scheduleSaveSession(),
  }),
  blend: new MicMatchKnob(document.getElementById("knobBlend"), {
    min: 0, max: 100, step: 5, value: 100, defaultValue: 100, unit: "%", label: "Intensità matching",
    onChange: () => scheduleSaveSession(),
  }),
  ceiling: new MicMatchKnob(document.getElementById("knobCeiling"), {
    min: -6, max: 0, step: 0.1, value: -0.3, defaultValue: -0.3, unit: " dBFS", label: "Soglia picchi",
    onChange: () => scheduleSaveSession(),
  }),
  rumble: new MicMatchKnob(document.getElementById("knobRumble"), {
    min: 0, max: 200, step: 5, value: 0, defaultValue: 0, unit: " Hz", label: "Anti-rimbombo (HPF)",
    onChange: () => scheduleSaveSession(),
  }),
  deess: new MicMatchKnob(document.getElementById("knobDeess"), {
    min: 0, max: 100, step: 5, value: 0, defaultValue: 0, unit: "%", label: "De-esser",
    onChange: () => scheduleSaveSession(),
  }),
  dereverb: new MicMatchKnob(document.getElementById("knobDereverb"), {
    min: 0, max: 100, step: 5, value: 0, defaultValue: 0, unit: "%", label: "Riduzione riverbero",
    onChange: () => scheduleSaveSession(),
  }),
};

// ---------------------------------------------------------------------------
// Selettore target di loudness (standard broadcast/streaming, vedi knob.js)
// ---------------------------------------------------------------------------

const LOUDNESS_OPTIONS = [
  { value: "reference", name: "Traccia di riferimento", detail: "" },
  { value: "none", name: "Nessuno", detail: "disattivato" },
  { value: -16, name: "Podcast", detail: "-16 LUFS" },
  { value: -14, name: "Streaming", detail: "Spotify/YouTube, -14 LUFS" },
  { value: -23, name: "Broadcast EU", detail: "EBU R128, -23 LUFS" },
  { value: -24, name: "Broadcast US", detail: "ATSC A/85, -24 LUFS" },
  { value: -27, name: "Netflix / OTT", detail: "-27 LUFS" },
];

const loudnessSelector = new MicMatchSelector(document.getElementById("selectorLoudness"), {
  options: LOUDNESS_OPTIONS,
  defaultIndex: 0, // "reference"
  label: "",
  onChange: () => scheduleSaveSession(),
});

// ---------------------------------------------------------------------------
// Plotting: spettro su asse X logaritmico (20Hz - 20kHz)
// ---------------------------------------------------------------------------

const PLOT_FREQ_MIN = 20;
const PLOT_FREQ_MAX = 20000;

function freqToX(freq, width) {
  const t = (Math.log10(freq) - Math.log10(PLOT_FREQ_MIN)) / (Math.log10(PLOT_FREQ_MAX) - Math.log10(PLOT_FREQ_MIN));
  return Math.max(0, Math.min(width, t * width));
}

function plotCurves(canvas, curves, opts = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const allDb = curves.flatMap((c) => c.db);
  let dbMin = opts.dbMin ?? Math.min(...allDb, -60);
  let dbMax = opts.dbMax ?? Math.max(...allDb, 0);
  if (opts.symmetric) {
    const m = Math.max(Math.abs(dbMin), Math.abs(dbMax), 3);
    dbMin = -m;
    dbMax = m;
  } else {
    const pad = (dbMax - dbMin) * 0.1 || 3;
    dbMin -= pad;
    dbMax += pad;
  }

  const dbToY = (db) => {
    const t = (db - dbMin) / (dbMax - dbMin);
    return height - t * height;
  };

  // griglia
  ctx.strokeStyle = "#2a2e37";
  ctx.lineWidth = 1;
  [100, 1000, 10000].forEach((f) => {
    const x = freqToX(f, width);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  });
  if (opts.symmetric) {
    const zeroY = dbToY(0);
    ctx.strokeStyle = "#3a3f4a";
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(width, zeroY);
    ctx.stroke();
  }

  curves.forEach((curve) => {
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = 1.6;
    if (curve.dashed) ctx.setLineDash([4, 3]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    curve.freqs.forEach((f, i) => {
      const x = freqToX(f, width);
      const y = dbToY(curve.db[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------------------
// Riferimento
// ---------------------------------------------------------------------------

async function loadReference(filePath) {
  state.referencePath = filePath;
  els.referenceInfo.className = "file-info";
  els.referenceInfo.textContent = "Analisi in corso…";

  try {
    const analysis = await window.micMatchAPI.analyze(filePath);
    state.referenceSpectrum = analysis.spectrum;
    const name = filePath.split(/[\\/]/).pop();
    els.referenceInfo.innerHTML =
      `<span class="file-name">${escapeHtml(name)}</span>` +
      `${analysis.duration.toFixed(1)}s · ${analysis.sample_rate}Hz · ${analysis.channels}ch · ` +
      `${analysis.lufs.toFixed(1)} LUFS`;
    els.referenceAudio.src = `file://${filePath}`;
    els.referenceAudio.classList.remove("hidden");
    plotCurves(els.referenceSpectrumCanvas, [
      { freqs: analysis.spectrum.freqs, db: analysis.spectrum.db, color: "#4fd1c5" },
    ]);
    scheduleSaveSession();
  } catch (err) {
    showError(`Errore analizzando il riferimento: ${err.message}`, err.details);
    els.referenceInfo.className = "file-info empty";
    els.referenceInfo.textContent = "Nessun file selezionato";
    els.referenceAudio.classList.add("hidden");
    els.referenceAudio.removeAttribute("src");
    state.referencePath = null;
  }
  updateProcessButtonState();
}

els.btnSelectReference.addEventListener("click", async () => {
  const filePath = await window.micMatchAPI.selectReferenceFile();
  if (!filePath) return;
  loadReference(filePath);
});

// ---------------------------------------------------------------------------
// Riferimento: modalità "microfono" (risposta in frequenza tipica invece di
// una traccia audio registrata)
// ---------------------------------------------------------------------------

async function loadMicProfileSpectrum(profileId) {
  try {
    const { spectrum } = await window.micMatchAPI.micProfileSpectrum(profileId, 31);
    plotCurves(els.referenceSpectrumCanvas, [{ freqs: spectrum.freqs, db: spectrum.db, color: "#4fd1c5" }]);
  } catch (err) {
    showError(`Errore caricando il profilo microfono: ${err.message}`, err.details);
  }
}

async function initMicProfiles() {
  try {
    const { profiles } = await window.micMatchAPI.listMicProfiles();
    state.micProfiles = profiles;
    els.micProfileSelect.innerHTML = profiles
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
      .join("");
    if (profiles.length > 0) {
      state.micProfile = profiles[0].id;
      els.micProfileNote.textContent = profiles[0].note || "";
    }
  } catch (err) {
    showError(`Errore caricando i profili microfono: ${err.message}`, err.details);
  }
}

els.micProfileSelect.addEventListener("change", () => {
  state.micProfile = els.micProfileSelect.value;
  const profile = state.micProfiles.find((p) => p.id === state.micProfile);
  els.micProfileNote.textContent = profile ? profile.note || "" : "";
  if (state.referenceMode === "mic_profile") loadMicProfileSpectrum(state.micProfile);
  updateProcessButtonState();
  scheduleSaveSession();
});

function setReferenceMode(mode) {
  state.referenceMode = mode;
  els.referenceModeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  els.referenceTrackMode.classList.toggle("hidden", mode !== "track");
  els.referenceMicMode.classList.toggle("hidden", mode !== "mic_profile");

  // In modalità microfono non esiste un loudness "di riferimento": il
  // backend lo disattiva comunque lato server, ma se l'utente ha selezionato
  // proprio "Traccia di riferimento" nel selettore lo spostiamo su "Nessuno"
  // per non confondere (e lo ripristiniamo tornando in modalità traccia).
  if (mode === "mic_profile") {
    if (loudnessSelector.value === "reference") {
      loudnessSelector._wasReference = true;
      loudnessSelector.setValueIfExists("none", false);
    }
    if (state.micProfile) loadMicProfileSpectrum(state.micProfile);
  } else if (loudnessSelector._wasReference) {
    loudnessSelector._wasReference = false;
    loudnessSelector.setValueIfExists("reference", false);
  }

  updateProcessButtonState();
  scheduleSaveSession();
}

els.referenceModeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => setReferenceMode(btn.dataset.mode));
});

renderPresetSelect();
initMicProfiles().then(() => {
  const last = loadLastSession();
  if (last) {
    applySnapshot(last);
    showPresetStatus("Sessione precedente ripristinata.");
  }
});

// ---------------------------------------------------------------------------
// Tracce target
// ---------------------------------------------------------------------------

function addTargetFiles(filePaths) {
  for (const p of filePaths) {
    if (!state.targetPaths.includes(p)) state.targetPaths.push(p);
  }
  renderTargetList();
  updateProcessButtonState();
  scheduleSaveSession();
}

els.btnAddTargets.addEventListener("click", async () => {
  const filePaths = await window.micMatchAPI.selectTargetFiles();
  addTargetFiles(filePaths);
});

function renderTargetList() {
  els.targetList.innerHTML = "";
  state.targetPaths.forEach((filePath) => {
    const name = filePath.split(/[\\/]/).pop();
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    nameSpan.textContent = name;
    nameSpan.title = filePath;
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-icon";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      state.targetPaths = state.targetPaths.filter((p) => p !== filePath);
      renderTargetList();
      updateProcessButtonState();
      scheduleSaveSession();
    });
    li.appendChild(nameSpan);
    li.appendChild(removeBtn);
    els.targetList.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Drag & drop file
// ---------------------------------------------------------------------------

function isAudioFile(name) {
  const ext = name.split(".").pop().toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

function pathsFromDropEvent(e) {
  return Array.from(e.dataTransfer.files)
    .filter((f) => isAudioFile(f.name))
    .map((f) => window.micMatchAPI.getPathForFile(f))
    .filter(Boolean);
}

function setupDropzone(panelEl, onDropPaths) {
  ["dragenter", "dragover"].forEach((evt) => {
    panelEl.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      panelEl.classList.add("dragover");
    });
  });

  panelEl.addEventListener("dragleave", (e) => {
    if (!panelEl.contains(e.relatedTarget)) {
      panelEl.classList.remove("dragover");
    }
  });

  panelEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    panelEl.classList.remove("dragover");
    const paths = pathsFromDropEvent(e);
    if (paths.length === 0) {
      showError("Il file trascinato non sembra un file audio supportato (wav, aiff, flac, mp3, m4a, caf).");
      return;
    }
    onDropPaths(paths);
  });
}

setupDropzone(els.referencePanel, (paths) => {
  setReferenceMode("track"); // trascinare un file implica "voglio usare una traccia audio"
  loadReference(paths[0]);
});
setupDropzone(els.targetsPanel, (paths) => addTargetFiles(paths));

// ---------------------------------------------------------------------------
// Impostazioni
// ---------------------------------------------------------------------------

els.btnSelectOutput.addEventListener("click", async () => {
  const dir = await window.micMatchAPI.selectOutputDir();
  if (!dir) return;
  state.outputDir = dir;
  els.outputDirLabel.textContent = dir;
  scheduleSaveSession();
});

els.numBands.addEventListener("change", () => scheduleSaveSession());
els.firTaps.addEventListener("change", () => scheduleSaveSession());

els.btnQuit.addEventListener("click", () => {
  window.micMatchAPI.quitApp();
});

// ---------------------------------------------------------------------------
// Elaborazione
// ---------------------------------------------------------------------------

function updateProcessButtonState() {
  const hasReference = state.referenceMode === "mic_profile" ? !!state.micProfile : !!state.referencePath;
  els.btnProcess.disabled = !(hasReference && state.targetPaths.length > 0);
}

// message: testo comprensibile (gia' pensato per l'utente da
// friendly_error_message() lato Python, o scritto qui per errori lato UI).
// details (opzionale): traceback/log tecnico, mostrato solo dietro un
// "Dettagli tecnici" collassabile - non lo sbattiamo in faccia di default.
function showError(message, details) {
  els.errorBox.innerHTML = "";
  const p = document.createElement("div");
  p.textContent = message;
  els.errorBox.appendChild(p);
  if (details) {
    const disclosure = document.createElement("details");
    disclosure.className = "error-details";
    const summary = document.createElement("summary");
    summary.textContent = "Dettagli tecnici";
    disclosure.appendChild(summary);
    const pre = document.createElement("pre");
    pre.textContent = details;
    disclosure.appendChild(pre);
    els.errorBox.appendChild(disclosure);
  }
  els.errorBox.classList.remove("hidden");
}
function clearError() {
  els.errorBox.classList.add("hidden");
  els.errorBox.innerHTML = "";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

els.btnProcess.addEventListener("click", async () => {
  clearError();
  els.btnProcess.disabled = true;
  els.progressWrap.classList.remove("hidden");
  els.progressFill.style.width = "0%";
  els.progressLabel.textContent = "Avvio…";
  els.resultsList.innerHTML = "";

  const unsubscribe = window.micMatchAPI.onProgress((progress) => {
    els.progressFill.style.width = `${progress.percent}%`;
    els.progressLabel.textContent = progress.message || progress.stage || "";
  });

  const config = {
    max_boost_db: knobs.maxBoost.value,
    max_cut_db: knobs.maxCut.value,
    loudness_target: loudnessSelector.value,
    blend: knobs.blend.value / 100,
    ceiling_db: knobs.ceiling.value,
    rumble_hz: knobs.rumble.value,
    deess_amount: knobs.deess.value / 100,
    dereverb_amount: knobs.dereverb.value / 100,
    num_bands: parseInt(els.numBands.value, 10),
    fir_taps: parseInt(els.firTaps.value, 10),
  };

  try {
    const result = await window.micMatchAPI.process({
      referenceMode: state.referenceMode,
      referencePath: state.referencePath,
      micProfile: state.micProfile,
      targetPaths: state.targetPaths,
      outputDir: state.outputDir,
      config,
    });
    renderResults(result);
    els.progressLabel.textContent = "Completato";
  } catch (err) {
    showError(`Errore durante l'elaborazione: ${err.message}`, err.details);
  } finally {
    unsubscribe();
    els.btnProcess.disabled = false;
    updateProcessButtonState();
  }
});

function renderResults(result) {
  els.resultsList.innerHTML = "";
  result.results.forEach((item) => {
    const card = document.createElement("div");
    card.className = "result-card";

    const name = item.source_path.split(/[\\/]/).pop();
    card.innerHTML = `
      <div class="result-title">${escapeHtml(name)}</div>
      <div class="result-meta">
        LUFS: ${item.lufs_before.toFixed(1)} → ${item.lufs_after.toFixed(1)}
        (${item.loudness_gain_db >= 0 ? "+" : ""}${item.loudness_gain_db.toFixed(1)} dB)
      </div>
      <div class="result-canvases">
        <canvas class="canvas-spectrum" width="440" height="110"></canvas>
        <canvas class="canvas-gain" width="440" height="110"></canvas>
      </div>
      <div class="result-actions">
        <span>Originale:</span>
        <audio controls src="file://${item.source_path}"></audio>
        <span>Adattato:</span>
        <audio controls src="file://${item.output_path}"></audio>
        <button class="btn btn-secondary btn-reveal">Mostra nel Finder</button>
      </div>
    `;

    const spectrumCanvas = card.querySelector(".canvas-spectrum");
    plotCurves(spectrumCanvas, [
      { freqs: result.reference.spectrum.freqs, db: result.reference.spectrum.db, color: "#4fd1c5", dashed: true },
      { freqs: item.spectrum_before.freqs, db: item.spectrum_before.db, color: "#e2685c" },
      { freqs: item.spectrum_after.freqs, db: item.spectrum_after.db, color: "#f5d76e" },
    ]);

    const gainCanvas = card.querySelector(".canvas-gain");
    plotCurves(gainCanvas, [{ freqs: item.gain_curve.freqs, db: item.gain_curve.db, color: "#8fd6ff" }], {
      symmetric: true,
    });

    card.querySelector(".btn-reveal").addEventListener("click", () => {
      window.micMatchAPI.revealInFolder(item.output_path);
    });

    els.resultsList.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Persistenza: preset salvabili + ripristino automatico dell'ultima sessione
// ---------------------------------------------------------------------------
//
// Tutto via localStorage del renderer: per uso locale non serve passare dal
// processo main, e localStorage di Electron sopravvive ai riavvii dell'app
// su questa stessa installazione (e' legato al profilo utente dell'app, non
// alla sessione della finestra).

const LAST_SESSION_KEY = "micmatch.lastSession";
const PRESETS_KEY = "micmatch.presets";
let saveSessionTimer = null;

function buildSnapshot() {
  return {
    referenceMode: state.referenceMode,
    referencePath: state.referencePath,
    micProfile: state.micProfile,
    targetPaths: state.targetPaths.slice(),
    outputDir: state.outputDir,
    knobs: {
      maxBoost: knobs.maxBoost.value,
      maxCut: knobs.maxCut.value,
      blend: knobs.blend.value,
      ceiling: knobs.ceiling.value,
      rumble: knobs.rumble.value,
      deess: knobs.deess.value,
      dereverb: knobs.dereverb.value,
    },
    loudnessTarget: loudnessSelector.value,
    numBands: els.numBands.value,
    firTaps: els.firTaps.value,
  };
}

function saveLastSession() {
  try {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(buildSnapshot()));
  } catch (_) {
    /* storage pieno o non disponibile: non e' critico per l'uso dell'app */
  }
}

function scheduleSaveSession() {
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(saveLastSession, 400);
}

function loadLastSession() {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function getPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function savePresets(presets) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch (_) {
    showError("Impossibile salvare il preset (storage locale pieno o non disponibile).");
  }
}

function renderPresetSelect(selectName) {
  const presets = getPresets();
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b, "it"));

  // Costruito via DOM (non innerHTML con stringhe interpolate): un nome di
  // preset con una virgoletta dentro romperebbe l'attributo value con la
  // concatenazione di stringhe, anche passando da escapeHtml (che sfugge
  // < > & ma non le virgolette, corrette solo dentro un attributo).
  els.presetSelect.innerHTML = "";
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "— nessun preset —";
  els.presetSelect.appendChild(emptyOpt);
  names.forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    els.presetSelect.appendChild(opt);
  });

  if (selectName && names.includes(selectName)) els.presetSelect.value = selectName;
  updatePresetButtonsState();
}

function updatePresetButtonsState() {
  const hasSelection = !!els.presetSelect.value;
  els.btnLoadPreset.disabled = !hasSelection;
  els.btnDeletePreset.disabled = !hasSelection;
}

// message: testo di stato. onUndo (opzionale): se presente, aggiunge un link
// "Annulla" cliccabile accanto al messaggio. NIENT dialog nativi (alert/
// confirm/prompt) qui: window.prompt() non e' implementato in Electron e
// resta bloccato in attesa di una risposta che non arriva mai (verificato
// durante lo sviluppo) - tutte le conferme passano da qui.
function showPresetStatus(message, onUndo) {
  els.presetStatus.innerHTML = "";
  els.presetStatus.appendChild(document.createTextNode(message));
  if (onUndo) {
    const link = document.createElement("span");
    link.className = "undo-link";
    link.textContent = "Annulla";
    link.addEventListener("click", () => {
      clearTimeout(showPresetStatus._t);
      els.presetStatus.textContent = "";
      onUndo();
    });
    els.presetStatus.appendChild(link);
  }
  clearTimeout(showPresetStatus._t);
  showPresetStatus._t = setTimeout(() => {
    els.presetStatus.textContent = "";
  }, 6000);
}

// Riapplica uno snapshot (preset o ultima sessione) allo stato dell'app.
// Ordine importante: il profilo microfono va impostato PRIMA di
// setReferenceMode (che, se la modalita' e' "mic_profile", carica subito lo
// spettro del profilo corrente - deve gia' essere quello giusto). I knob e
// il target di loudness vanno impostati DOPO, perche' setReferenceMode ha
// una sua logica di sicurezza che puo' spostare il target di loudness su
// "none": la vogliamo sovrascrivere con il valore vero salvato nello snapshot.
async function applySnapshot(snap) {
  if (!snap) return;

  if (snap.micProfile && state.micProfiles.some((p) => p.id === snap.micProfile)) {
    state.micProfile = snap.micProfile;
    els.micProfileSelect.value = snap.micProfile;
    const profile = state.micProfiles.find((p) => p.id === snap.micProfile);
    els.micProfileNote.textContent = profile ? profile.note || "" : "";
  }

  setReferenceMode(snap.referenceMode || "track");

  if ((snap.referenceMode || "track") === "track" && snap.referencePath) {
    loadReference(snap.referencePath); // gestisce gia' da solo il caso file non piu' trovato
  }

  state.targetPaths = [];
  if (Array.isArray(snap.targetPaths) && snap.targetPaths.length) {
    addTargetFiles(snap.targetPaths);
  } else {
    renderTargetList();
  }

  if (snap.outputDir) {
    state.outputDir = snap.outputDir;
    els.outputDirLabel.textContent = snap.outputDir;
  }

  if (snap.knobs) {
    for (const key of Object.keys(knobs)) {
      if (typeof snap.knobs[key] === "number") knobs[key].setValue(snap.knobs[key], false);
    }
  }
  if (snap.loudnessTarget !== undefined) {
    loudnessSelector.setValueIfExists(snap.loudnessTarget, false);
  }
  if (snap.numBands) els.numBands.value = String(snap.numBands);
  if (snap.firTaps) els.firTaps.value = String(snap.firTaps);

  updateProcessButtonState();
}

els.btnSavePreset.addEventListener("click", () => {
  const name = els.presetNameInput.value.trim();
  if (!name) {
    showPresetStatus("Inserisci un nome per il preset qui sopra.");
    els.presetNameInput.focus();
    return;
  }
  const presets = getPresets();
  const overwriting = Object.prototype.hasOwnProperty.call(presets, name);
  presets[name] = buildSnapshot();
  savePresets(presets);
  renderPresetSelect(name);
  els.presetNameInput.value = "";
  showPresetStatus(overwriting ? `Preset "${name}" sovrascritto.` : `Preset "${name}" salvato.`);
});

els.presetNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.btnSavePreset.click();
});

els.btnLoadPreset.addEventListener("click", () => {
  const name = els.presetSelect.value;
  if (!name) return;
  const presets = getPresets();
  if (!presets[name]) return;
  applySnapshot(presets[name]);
  showPresetStatus(`Preset "${name}" caricato.`);
});

els.btnDeletePreset.addEventListener("click", () => {
  const name = els.presetSelect.value;
  if (!name) return;
  const presets = getPresets();
  const removed = presets[name];
  delete presets[name];
  savePresets(presets);
  renderPresetSelect();
  showPresetStatus(`Preset "${name}" eliminato.`, () => {
    const current = getPresets();
    current[name] = removed;
    savePresets(current);
    renderPresetSelect(name);
    showPresetStatus(`Preset "${name}" ripristinato.`);
  });
});

els.presetSelect.addEventListener("change", updatePresetButtonsState);

updateProcessButtonState();
