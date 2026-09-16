#!/usr/bin/env node
/**
 * Costruisce python-runtime/: l'interprete Python AUTONOMO spedito con
 * MicMatch (stesso meccanismo di ADR Studio Suite, vedi
 * ADR_11_Electron_Claude/scripts/setup-python-runtime.js per i commenti
 * estesi - qui la versione ridotta, perche' le dipendenze di MicMatch sono
 * molto piu' leggere: niente torch/whisperx/demucs, solo numpy/scipy/
 * soundfile/pyloudnorm/nara_wpe, quindi niente opzione --cuda ne' requisito
 * di git).
 *
 * PERCHE' NON BASTA UN VENV
 * Un venv non contiene un interprete, contiene un rimando a quello di
 * sistema (su macOS un symlink verso l'installazione Python della macchina
 * su cui e' stato creato). Su un'altra macchina quel link e' rotto, e
 * spawn() dell'app fallisce o - peggio - trova un python3 di sistema
 * qualunque senza numpy/scipy installati (esattamente il bug osservato
 * durante lo sviluppo di MicMatch). python-build-standalone produce invece
 * una distribuzione completa e relocatable, che dipende solo dalle
 * librerie di sistema del sistema operativo.
 *
 * Uso:
 *   node scripts/setup-python-runtime.js            installazione normale
 *   node scripts/setup-python-runtime.js --force    rifa' da zero un runtime gia' presente
 *   node scripts/setup-python-runtime.js --check    verifica soltanto, non installa
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Stessa release usata da ADR Studio Suite: gia' verificata/funzionante,
// riusarla riduce il rischio invece di puntare a un asset mai testato qui.
const PBS_TAG = '20260728';
const PBS_VERSION = '3.13.14';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'python-runtime');
const REQUIREMENTS = path.join(PROJECT_ROOT, 'python', 'requirements.txt');

const argv = process.argv.slice(2);
const OPT = {
  force: argv.includes('--force'),
  checkOnly: argv.includes('--check'),
};

const log = (msg) => console.log(msg);
const step = (msg) => console.log(`\n-> ${msg}`);
const fail = (msg) => {
  console.error(`\nERRORE: ${msg}`);
  process.exit(1);
};

function runtimePython(dir = RUNTIME_DIR) {
  return process.platform === 'win32'
    ? path.join(dir, 'python.exe')
    : path.join(dir, 'bin', 'python3');
}

function assetName() {
  const key = `${process.platform}-${process.arch}`;
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  };
  const triple = triples[key];
  if (!triple) fail(`piattaforma non gestita: ${key}`);
  return `cpython-${PBS_VERSION}+${PBS_TAG}-${triple}-install_only.tar.gz`;
}

// L'API di GitHub limita le richieste non autenticate a 60/ora per IP: sulle
// runner condivise di GitHub Actions si esaurisce facilmente (HTTP 403,
// osservato durante lo sviluppo). Se GITHUB_TOKEN/GH_TOKEN e' impostato (in
// Actions lo e' sempre, via secrets.GITHUB_TOKEN nel workflow) lo mandiamo
// come Authorization - solo verso api.github.com, mai verso l'host di
// download dell'asset (S3/objects.githubusercontent.com dopo il redirect).
function authHeaders(url) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return {};
  const host = new URL(url).hostname;
  return host === 'api.github.com' ? { Authorization: `Bearer ${token}` } : {};
}

function httpsGet(url, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error('troppi redirect'));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'micmatch-setup', Accept: '*/*', ...authHeaders(url) } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(httpsGet(next, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} su ${url}`));
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout di rete')));
  });
}

async function readAll(url) {
  const res = await httpsGet(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

async function download(url, dest, expectedBytes) {
  const res = await httpsGet(url);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let done = 0;
  let lastShown = 0;
  const total = Number(res.headers['content-length']) || expectedBytes || 0;

  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      hash.update(chunk);
      done += chunk.length;
      if (process.stdout.isTTY && done - lastShown > 2 * 1024 * 1024) {
        lastShown = done;
        const mb = (done / 1e6).toFixed(1);
        const pct = total ? ` (${Math.round((done / total) * 100)}%)` : '';
        process.stdout.write(`\r   ${mb} MB${pct}   `);
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  if (process.stdout.isTTY) process.stdout.write('\r');
  return hash.digest('hex');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return r.status === 0;
}

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).split(/\r?\n/)[0].trim() : null;
}

function tarExecutable() {
  if (process.platform !== 'win32') return 'tar';
  const native = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(native) ? native : 'tar';
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Verifica finale
// ---------------------------------------------------------------------------

const VERIFY_SNIPPET = `
import sys, os, json
runtime = os.path.realpath(sys.argv[1])
esterni = []
for p in sys.path:
    if not p:
        continue
    try:
        rp = os.path.realpath(p)
    except Exception:
        continue
    if not (rp == runtime or rp.startswith(runtime + os.sep)):
        esterni.append(p)
mancanti = []
for m in ('numpy', 'scipy', 'soundfile', 'pyloudnorm', 'nara_wpe'):
    try:
        __import__(m)
    except Exception as e:
        mancanti.append('%s (%s)' % (m, type(e).__name__))
print(json.dumps({
    'version': '.'.join(map(str, sys.version_info[:3])),
    'esterni': esterni,
    'mancanti': mancanti,
}))
`;

function verify(quiet = false) {
  const py = runtimePython();
  if (!fs.existsSync(py)) {
    if (!quiet) log(`   runtime assente (${py} non trovato)`);
    return false;
  }
  const r = spawnSync(py, ['-c', VERIFY_SNIPPET, RUNTIME_DIR], { encoding: 'utf8' });
  let info;
  try {
    info = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop());
  } catch {
    if (!quiet) {
      log('   impossibile interrogare il runtime:');
      log(String(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-5).join('\n'));
    }
    return false;
  }

  log(`   Python ${info.version}`);
  log(`   percorsi fuori dal runtime: ${info.esterni.length}   (deve essere 0)`);
  if (info.esterni.length) info.esterni.forEach((p) => log(`      ${p}`));
  log(`   moduli mancanti: ${info.mancanti.length ? info.mancanti.join(', ') : 'nessuno'}`);

  return info.esterni.length === 0 && info.mancanti.length === 0;
}

// ---------------------------------------------------------------------------
// Installazione dei pacchetti
// ---------------------------------------------------------------------------

function installPackages() {
  const py = runtimePython();

  if (!fs.existsSync(REQUIREMENTS)) {
    fail(`${REQUIREMENTS} non trovato`);
  }

  step('Aggiorno pip');
  if (!run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'])) {
    fail('aggiornamento di pip fallito');
  }

  step('Installo le dipendenze (numpy, scipy, soundfile, pyloudnorm, nara_wpe)');
  if (!run(py, ['-m', 'pip', 'install', '-r', REQUIREMENTS])) {
    fail('installazione delle dipendenze fallita (vedi output sopra)');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const asset = assetName();

  log('== Runtime Python autonomo (MicMatch) ==');
  log(`Piattaforma:  ${process.platform}-${process.arch}`);
  log(`Versione:     ${PBS_VERSION} (${asset})`);
  log(`Destinazione: ${RUNTIME_DIR}`);

  if (OPT.checkOnly) {
    step('Verifica del runtime esistente');
    process.exit(verify() ? 0 : 1);
  }

  const alreadyThere = fs.existsSync(runtimePython());

  if (alreadyThere && OPT.force) {
    step('--force: rimuovo il runtime esistente');
    rmrf(RUNTIME_DIR);
  } else if (alreadyThere) {
    step('Runtime gia\' presente, verifico');
    if (verify()) {
      log('\n== Gia\' pronto, niente da fare ==');
      log('   Per rifarlo da zero: node scripts/setup-python-runtime.js --force');
      return;
    }
    log('\n   Il runtime esiste ma e\' incompleto: completo l\'installazione dei pacchetti.');
    installPackages();
    step('Verifica finale');
    if (!verify()) fail('il runtime resta incompleto, vedi sopra');
    log(`\n== Runtime pronto in ${RUNTIME_DIR} ==`);
    return;
  }

  if (!which('tar')) {
    fail(
      'il comando tar non e\' disponibile.\n' +
        '  Su Windows tar fa parte del sistema dalla versione 10 build 17063 (2018).'
    );
  }

  step('Cerco l\'asset nella release di python-build-standalone');
  const relUrl = `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${PBS_TAG}`;
  let release;
  try {
    release = JSON.parse((await readAll(relUrl)).toString('utf8'));
  } catch (e) {
    fail(`impossibile leggere la release da GitHub: ${e.message}`);
  }
  const meta = (release.assets || []).find((a) => a.name === asset);
  if (!meta) fail(`asset ${asset} non trovato nella release ${PBS_TAG}`);

  const expected = String(meta.digest || '').replace('sha256:', '');
  log(`   ${asset} — ${(meta.size / 1e6).toFixed(1)} MB`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'micmatch-pyrt-'));
  const archive = path.join(tmp, 'python.tar.gz');

  try {
    step('Scarico');
    const actual = await download(meta.browser_download_url, archive, meta.size);

    step('Verifico il checksum');
    if (!expected) {
      fail('GitHub non espone il digest dell\'asset: verifica impossibile, mi fermo.');
    }
    if (expected !== actual) {
      fail(
        `checksum non corrispondente!\n  atteso:    ${expected}\n  calcolato: ${actual}\n` +
          '  Non installo. Riprova; se persiste, il download e\' compromesso o corrotto.'
      );
    }
    log(`   ok (${actual})`);

    step('Estraggo');
    if (!run(tarExecutable(), ['-xzf', archive, '-C', tmp])) fail('estrazione fallita');
    const extracted = path.join(tmp, 'python');
    if (!fs.existsSync(extracted)) fail(`l'archivio non contiene la cartella attesa "python"`);

    try {
      fs.renameSync(extracted, RUNTIME_DIR);
    } catch {
      fs.cpSync(extracted, RUNTIME_DIR, { recursive: true });
    }
    if (!fs.existsSync(runtimePython())) {
      fail(`estrazione riuscita ma ${runtimePython()} non esiste`);
    }
  } finally {
    rmrf(tmp);
  }

  installPackages();

  step('Verifica finale');
  if (!verify()) {
    fail('il runtime non ha passato la verifica, vedi sopra');
  }

  log(`\n== Runtime pronto in ${RUNTIME_DIR} ==`);
  log('   main.js lo preferisce automaticamente al Python di sistema (vedi resolvePythonExecutable).');
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
