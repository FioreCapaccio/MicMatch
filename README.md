# MicMatch

App desktop (Electron + Python) per adattare il timbro di registrazioni fatte
con microfoni diversi verso una traccia di riferimento, o verso la risposta
in frequenza tipica di un modello di microfono noto (es. Neumann U87).

Uso personale, non firmata/notarizzata, non pensata per la distribuzione ad
altri (vedi [Limiti noti](#limiti-noti)).

## Cosa fa

1. **Riferimento**: una traccia audio registrata, oppure un profilo
   microfono predefinito (curva di frequenza approssimata).
2. **Tracce da adattare**: una o più registrazioni fatte con un microfono
   diverso, da correggere verso il riferimento.
3. **Elaborazione** (motore Python, offline): EQ matching, loudness
   matching (verso il riferimento o uno standard broadcast/streaming),
   filtro anti-rimbombo, de-esser dinamico, riduzione del riverbero (WPE),
   limiter di sicurezza. Ogni stadio è opzionale e regolabile con un knob.

## Architettura

```
main.js         processo Electron principale: finestra, dialog nativi,
                spawn del motore Python, risoluzione percorsi dev/pacchetto
preload.js      ponte IPC (contextBridge) verso il renderer
renderer/       interfaccia (HTML/CSS/JS puro, nessun framework)
python/         motore DSP (mic_match.py) + requirements
python-runtime/ interprete Python AUTONOMO (non committato, si rigenera)
scripts/        script di build (setup del runtime Python)
build/          icona dell'app
```

Il processo main comunica con `python/mic_match.py` via stdin/stdout JSON
(protocollo descritto in cima al file: righe `PROGRESS:`/`RESULT:`/`ERROR:`).
Ogni azione (`analyze`, `match`, `list_mic_profiles`, ...) è una singola
chiamata: un processo Python per invocazione, non un server persistente.

### Perché un Python autonomo

`python-runtime/` è una distribuzione Python completa e rilocabile
([python-build-standalone](https://github.com/astral-sh/python-build-standalone)),
non un venv: un venv contiene solo un *rimando* all'interprete di sistema
usato per crearlo, quindi si rompe sia spostando la cartella del progetto,
sia su una macchina diversa da quella in cui è stato creato. Il runtime
autonomo invece funziona anche senza Python installato sul sistema — è
quello che main.js usa in produzione (vedi `resolvePythonExecutable()`).

## Sviluppo

Prerequisiti: Node.js, e per il motore Python un interprete di sistema
(qualsiasi versione recente di Python 3) usato solo per creare il venv di
sviluppo.

```bash
npm install

# venv di sviluppo (comodo: non serve rifare il runtime standalone ad ogni modifica)
cd python
python3 -m venv venv
./venv/bin/pip install -r requirements-dev.txt   # include requirements.txt + pytest
cd ..

npm start   # avvia l'app in modalità sviluppo
```

**Attenzione**: un venv Python non è rilocabile — se sposti la cartella del
progetto, `python/venv/` va ricreato da zero (i comandi sopra). `main.js`
se ne accorge da solo e usa il Python di sistema come ripiego, ma è più
lento e meno affidabile del venv.

### Test

```bash
python/venv/bin/pytest python/tests/
```

27 test sul motore DSP (`python/tests/test_dsp.py`): non testano la
"qualità audio" (soggettiva), ma bloccano le regressioni su comportamenti
già verificati a mano durante lo sviluppo — in particolare un bug reale
trovato una volta (un singolo picco isolato che abbassava il volume di
tutto il file). Se tocchi `python/mic_match.py`, rilanciali prima di
considerare finita la modifica.

## Build

```bash
npm run setup:python   # scarica/aggiorna python-runtime/ (una volta, o dopo aver cambiato python/requirements.txt)
npm run build:mac      # produce dist/MicMatch-*.dmg e .zip
```

Solo build arm64 (Apple Silicon) per ora — vedi [Limiti noti](#limiti-noti).
Ricompila (`npm run build:mac`) dopo ogni modifica al codice: `npm start`
prende sempre i sorgenti più recenti, ma il pacchetto in `dist/` resta
quello dell'ultima build finché non lo rifai.

## Glossario impostazioni

| Controllo | Cosa fa |
|---|---|
| Boost/Taglio max per banda | Limiti dell'EQ di matching, per banda di frequenza |
| Intensità matching | 0-100%: quanto della correzione calcolata applicare (blend secco/processato) |
| Soglia picchi | Ceiling del limiter di sicurezza finale (dBFS) |
| Anti-rimbombo (HPF) | Filtro passa-alto, 0 = disattivato |
| De-esser | Riduzione dinamica delle sibilanti (banda 4-9kHz), 0 = disattivato |
| Riduzione riverbero | WPE — effetto **modesto** in mono (vedi commento in `dereverb()` in mic_match.py), 0 = disattivato |
| Target di loudness | LUFS del riferimento, uno standard broadcast/streaming, o nessuno |
| Risoluzione EQ / Qualità filtro | Compromesso precisione/velocità del matching |

Interazione con i knob: trascina verticalmente per regolare (Shift = fine),
rotellina per piccoli step, doppio click per il valore di default.

## Preset e sessione

- **Preset di fabbrica** (`FACTORY_PRESETS` in renderer.js): 5 punti di
  partenza per dialoghi da film, basati su prassi consolidate di ADR e
  mastering per la consegna broadcast/streaming — non toccano riferimento/
  target/cartella di output, solo la "ricetta" timbrica (knob, loudness,
  qualità). Non eliminabili, non sovrascrivibili da un preset utente con lo
  stesso nome.
  - *ADR — Match produzione (delicato)*: correzione contenuta e trasparente
    per l'inserimento ADR, loudness verso il riferimento.
  - *ADR — Match produzione + camera viva*: come sopra, con una riduzione
    leggera del riverbero per una cabina non perfettamente trattata.
  - *Dialoghi — Consegna Netflix/OTT*: -27 LUFS dialogue-gated, -2dBTP.
  - *Dialoghi — Consegna Broadcast EU*: EBU R128, -23 LUFS, -1dBTP.
  - *Dialoghi — Consegna Broadcast US*: ATSC A/85, -24 LUFS, -2dBTP.
- **Preset ambientali** (`AMBIENT_PRESETS` in renderer.js): 3 simulazioni di
  posizionamento/ambientazione, via EQ stilizzata verso una delle curve
  `ambient_*` di `MIC_PROFILES` in mic_match.py. A differenza dei preset di
  fabbrica sopra, QUESTI cambiano il riferimento (passano in modalità
  "profilo microfono / ambientazione"): caricarne uno sostituisce
  qualunque traccia di riferimento o profilo microfono già selezionato.
  Sono pura EQ — l'app non ha un motore di riverbero sintetico, quindi non
  aggiungono prime riflessioni, ritardo o coda di riverbero, solo il
  bilanciamento tonale tipico della posizione. Non eliminabili, non
  sovrascrivibili da un preset utente con lo stesso nome.
  - *Ambiente — Presenza ravvicinata*: enfasi dell'effetto di prossimità
    (bassi ~150Hz) e della presenza (2-5kHz).
  - *Ambiente — Voce a distanza*: perdita di acuti (assorbimento dell'aria)
    e calo di presenza.
  - *Ambiente — Voce all'aperto*: meno corpo medio-basso da riflessioni
    (assenti all'aperto), acuti leggermente più ariosi.
- **Preset utente**: salvabili/richiamabili con un nome, da localStorage (non
  file su disco). Cattura l'intera sessione: riferimento, target, tutti i
  knob, target di loudness, cartella di output.
- **Ultima sessione**: salvata automaticamente ad ogni modifica e
  ripristinata al prossimo avvio.

Vivono nel profilo utente dell'app Electron (`localStorage` legato a
`app.getPath('userData')`), non in un file che puoi copiare a mano su
un'altra installazione.

## Limiti noti

- **Non firmata/notarizzata**: su un altro Mac, macOS blocca l'app come
  "danneggiata". Per uso personale su questa macchina non è un problema.
- **Solo arm64** (Apple Silicon): nessun binario Intel.
- **Riduzione riverbero debole in mono**: WPE ha bisogno di più canali per
  funzionare bene; su una singola voce l'effetto è reale ma modesto (pochi
  dB), non un'asciugatura drastica della stanza.
- **`window.prompt()`/`window.confirm()` non usati apposta**: verificato
  che si bloccano senza mai risolvere in questa versione di Electron — tutte
  le conferme in UI passano da elementi HTML propri (campi di testo,
  `<details>`, link "Annulla"), non da dialog nativi del browser.
- **I profili microfono sono approssimati**: curve indicative costruite a
  mano dalle caratteristiche generali note di ogni modello, non misurazioni
  di laboratorio né riproduzioni dei grafici dei produttori.
- **Le ambientazioni sono EQ, non spazializzazione**: i profili/preset
  `ambient_*` (vicino/distante/esterno) sono un'equalizzazione stilizzata,
  non una simulazione fisica — nessun riverbero sintetico, prime
  riflessioni o delay, perché l'app non ha un motore di riverbero
  convoluzionale.

## Struttura del codice Python (`python/mic_match.py`)

Protocollo I/O e azioni disponibili documentati nel docstring in cima al
file. Le funzioni DSP principali (con i limiti/scelte progettuali spiegati
nei rispettivi docstring): `build_gain_curve`, `design_fir`,
`true_peak_limiter`, `remove_rumble`, `deess`, `dereverb`,
`check_audio_usable`, `friendly_error_message`.
