#!/usr/bin/env python3
"""
MicMatch - Motore DSP per l'adattamento timbrico tra microfoni diversi.

Idea: data una traccia di riferimento (il "suono" a cui vogliamo che tutto
assomigli) e una o piu' tracce sorgente registrate con microfoni/ambienti
diversi, calcola una curva di equalizzazione (differenza spettrale media
riferimento - sorgente, smussata) e un fattore di loudness matching, e
produce versioni delle sorgenti che suonano il piu' possibile vicine al
riferimento.

Limite noto (dichiarato, non un bug): questo approccio corregge timbro
(EQ) e volume/dinamica media (loudness). NON prova a rimuovere o ricreare
il riverbero/ambiente della stanza di ripresa originale - quello
richiederebbe de-reverb + re-reverb, molto piu' complesso e fuori scope.

Protocollo I/O (stesso pattern usato in ADR Studio Suite):
  stdin  <- singola riga JSON con l'azione richiesta
  stdout -> PROGRESS:<json>   { percent, stage, message }
  stdout -> RESULT:<json>     payload specifico per azione
  stdout -> ERROR:<json>      { message, details }  # message: leggibile per
                              # l'utente; details: traceback completo, solo
                              # per debug (vedi friendly_error_message())
  exit 0 successo, 1 errore.

Azioni:

  "analyze": { "path": "..." }
    -> RESULT { duration, sample_rate, channels, lufs, peak_db,
                spectrum: { freqs, db } }

  "list_mic_profiles": {}
    -> RESULT { profiles: [ { id, name, note }, ... ] }

  "mic_profile_spectrum": { "profile_id": "u87", "num_bands": 31 }
    -> RESULT { spectrum: { freqs, db } }

  "match": {
      "reference_mode": "track" | "mic_profile",   # default "track"
      "reference_path": "...",                      # richiesto se reference_mode == "track"
      "mic_profile": "u87",                          # richiesto se reference_mode == "mic_profile"
      "target_paths": ["...", "..."],
      "output_dir": "...",
      "config": {
        "max_boost_db": 6.0,
        "max_cut_db": 12.0,
        "num_bands": 31,
        "loudness_target": "reference",  # "reference" | "none" | numero LUFS (es. -16, -23)
        "fir_taps": 2047,
        "blend": 1.0,
        "ceiling_db": -0.3,
        "rumble_hz": 0.0,
        "deess_amount": 0.0,
        "dereverb_amount": 0.0
      }
    }
    -> RESULT {
         reference: { spectrum: {freqs, db}, lufs },  # lufs = null in modalita' mic_profile
         results: [
           {
             source_path, output_path,
             spectrum_before: {freqs, db},
             spectrum_after:  {freqs, db},
             gain_curve: {freqs, db},
             lufs_before, lufs_after,
             loudness_gain_db
           },
           ...
         ]
       }

"rumble_hz" (filtro passa-alto anti-rimbombo), "deess_amount" (de-esser a
banda separata 4-9kHz) e "dereverb_amount" (riduzione riverbero via WPE)
sono tutti disattivati di default (0). Ordine della catena per ogni target:
rumble -> dereverb -> match EQ -> de-esser -> loudness match -> limiter.
Vedi remove_rumble()/dereverb()/deess() piu' sotto per i dettagli.

Modalita' "mic_profile": invece di caricare un file audio di riferimento,
la curva di equalizzazione target e' la risposta in frequenza *approssimata*
di un modello di microfono noto (vedi MIC_PROFILES piu' sotto). In questa
modalita' non esiste un "loudness di riferimento": se "loudness_target"
arriva come "reference" viene declassato lato server a "none" (safety net -
il client dovrebbe gia' evitarlo), ma un target numerico esplicito (uno
standard broadcast/streaming) resta valido anche qui.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
from scipy.signal import welch, firwin2, fftconvolve, butter, sosfiltfilt
from scipy.ndimage import minimum_filter1d, maximum_filter1d, uniform_filter1d

try:
    import pyloudnorm as pyln
    HAVE_PYLOUDNORM = True
except ImportError:
    HAVE_PYLOUDNORM = False

try:
    from nara_wpe.wpe import wpe as _wpe
    from nara_wpe import utils as _wpe_utils
    HAVE_NARA_WPE = True
except ImportError:
    HAVE_NARA_WPE = False


# ---------------------------------------------------------------------------
# Protocollo stdin/stdout
# ---------------------------------------------------------------------------

def emit_progress(percent: float, stage: str = "", message: str = "") -> None:
    payload = {"percent": round(float(percent), 2), "stage": stage, "message": message}
    sys.stdout.write("PROGRESS:" + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_result(data: Dict[str, Any]) -> None:
    sys.stdout.write("RESULT:" + json.dumps(data, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_error(message: str, details: str = "") -> None:
    payload = {"message": str(message), "details": details}
    sys.stdout.write("ERROR:" + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def friendly_error_message(exc: BaseException) -> str:
    """Traduce le eccezioni piu' comuni in un messaggio comprensibile per chi
    usa l'app (non uno sviluppatore): prima si vedeva il traceback Python
    grezzo nel riquadro d'errore dell'interfaccia. Il traceback completo
    resta comunque disponibile a parte (vedi "details" in emit_error/
    main()) per chi deve fare debug.
    """
    if isinstance(exc, ValueError):
        # I ValueError sollevati da questo modulo (vedi _check_audio_usable,
        # mic_profile_spectrum, ecc.) hanno gia' un messaggio in italiano
        # pensato per essere letto cosi' com'e'.
        return str(exc)
    if isinstance(exc, FileNotFoundError):
        return "File non trovato: potrebbe essere stato spostato, rinominato o eliminato dopo la selezione."
    if isinstance(exc, PermissionError):
        return "Permesso negato: verifica i permessi di lettura/scrittura del file o della cartella di destinazione."
    if isinstance(exc, MemoryError):
        return "Il file e' troppo grande per essere elaborato con la memoria disponibile su questo computer."
    text = str(exc).lower()
    if any(s in text for s in ("format not recognised", "unknown format", "error opening", "unsupported")):
        return "Il file audio non e' leggibile: formato non supportato o file corrotto."
    return "Si e' verificato un errore imprevisto durante l'elaborazione."


# ---------------------------------------------------------------------------
# DSP core
# ---------------------------------------------------------------------------

EPS = 1e-12
MIN_FREQ_HZ = 20.0


def load_audio(path: str) -> Tuple[np.ndarray, int]:
    """Ritorna (samples, sample_rate). samples ha shape (n,) mono o (n, ch)."""
    # Controllo esplicito invece di lasciare fare a soundfile: per un file
    # davvero mancante, libsndfile risponde con un generico "System error"
    # che il pattern-matching di friendly_error_message() scambierebbe per
    # un file corrotto - un FileNotFoundError vero da' un messaggio giusto.
    if not Path(path).exists():
        raise FileNotFoundError(path)
    data, sr = sf.read(path, always_2d=False, dtype="float32")
    return data, sr


MIN_DURATION_SEC = 0.1
SILENCE_PEAK_THRESHOLD = 1e-5


def check_audio_usable(data: np.ndarray, sr: int, label: str) -> None:
    """Controlla che il file sia abbastanza lungo e non silenzioso prima di
    mandarlo nella pipeline DSP. Senza questo, un file troppo corto o vuoto
    puo' far fallire STFT/WPE piu' a fondo nella pipeline con un errore
    numpy/scipy poco chiaro (es. "cannot reshape array of size 0") invece di
    un messaggio comprensibile subito all'inizio.
    """
    duration = (len(data) / sr) if sr else 0.0
    if duration < MIN_DURATION_SEC:
        raise ValueError(
            f'"{label}" e\' troppo corto ({duration * 1000:.0f} ms): '
            f"serve almeno {int(MIN_DURATION_SEC * 1000)} ms di audio per poter essere elaborato."
        )
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak < SILENCE_PEAK_THRESHOLD:
        raise ValueError(f'"{label}" sembra silenzioso: non c\'e\' segnale utile da analizzare.')


def to_mono(data: np.ndarray) -> np.ndarray:
    if data.ndim == 1:
        return data
    return np.mean(data, axis=1)


def band_edges(sr: int, num_bands: int) -> np.ndarray:
    nyquist = sr / 2.0
    hi = min(nyquist * 0.999, 20000.0)
    return np.logspace(np.log10(MIN_FREQ_HZ), np.log10(hi), num_bands + 1)


def band_spectrum(mono: np.ndarray, sr: int, num_bands: int) -> Tuple[np.ndarray, np.ndarray]:
    """Spettro medio (Welch, potenza) ridotto a `num_bands` bande log-spaziate.
    Ritorna (center_freqs, db_per_band)."""
    nperseg = min(8192, max(256, 1 << int(np.floor(np.log2(max(len(mono) // 8, 256))))))
    freqs, psd = welch(mono, fs=sr, nperseg=nperseg, noverlap=nperseg // 2)

    edges = band_edges(sr, num_bands)
    centers = np.sqrt(edges[:-1] * edges[1:])
    band_db = np.empty(num_bands, dtype=np.float64)

    for i in range(num_bands):
        lo, hi = edges[i], edges[i + 1]
        mask = (freqs >= lo) & (freqs < hi)
        if not np.any(mask):
            # banda troppo stretta per la risoluzione FFT: prendi il bin piu' vicino
            idx = int(np.argmin(np.abs(freqs - centers[i])))
            power = psd[idx]
        else:
            power = np.mean(psd[mask])
        band_db[i] = 10.0 * np.log10(power + EPS)

    return centers, band_db


# ---------------------------------------------------------------------------
# Profili microfono (alternativa alla traccia di riferimento)
# ---------------------------------------------------------------------------
#
# Curve *approssimate*, costruite a mano da poche coppie (Hz, dB) che
# riassumono il carattere timbrico generale e pubblicamente noto di ciascun
# modello (es. per lo Neumann U87 in cardioide: lieve roll-off dei bassi
# sotto ~80Hz, risposta sostanzialmente piatta nei medi, lieve enfasi di
# presenza tra 5 e 12kHz). Non sono misurazioni di laboratorio ne' una
# riproduzione dei grafici pubblicati dal produttore - servono solo a dare
# un bersaglio timbrico plausibile quando non si ha una traccia di
# riferimento registrata. I breakpoint vengono interpolati in scala
# logaritmica di frequenza sulla stessa griglia di bande usata per lo
# spettro delle tracce vere, cosi' il resto della pipeline (build_gain_curve,
# plotting) non deve distinguere le due modalita'.

MIC_PROFILES: Dict[str, Dict[str, Any]] = {
    "u87": {
        "name": "Neumann U87 (cardioide) — approssimato",
        "note": "Curva timbrica indicativa, non una misurazione di laboratorio.",
        "breakpoints": [
            (20, -8.0), (40, -4.0), (80, -0.5), (150, 0.0), (1000, 0.0),
            (3000, 0.3), (5000, 1.2), (7000, 2.3), (9000, 3.0), (11000, 2.2),
            (14000, 0.5), (18000, -2.0), (20000, -4.0),
        ],
    },
    "aston_spirit": {
        "name": "Aston Spirit (cardioide) — approssimato",
        "note": "Curva timbrica indicativa (condensatore, bassi estesi, presenza morbida), non una misurazione di laboratorio.",
        "breakpoints": [
            (20, -6.0), (30, -3.0), (60, -0.5), (150, 0.0), (1000, 0.0),
            (3000, 0.2), (5000, 1.0), (8000, 2.0), (11000, 2.2), (14000, 1.0),
            (18000, -1.0), (20000, -2.5),
        ],
    },
    "shure_sm7b": {
        "name": "Shure SM7B (cardioide, dinamico) — approssimato",
        "note": (
            "Curva timbrica indicativa con gli switch interni (bass roll-off, presence boost) "
            "in posizione flat; non una misurazione di laboratorio."
        ),
        "breakpoints": [
            (20, -10.0), (50, -1.0), (100, 0.0), (300, 0.0), (1000, 0.0),
            (2000, 0.2), (4000, 0.5), (6000, 0.3), (8000, -0.5), (10000, -2.0),
            (13000, -4.0), (16000, -7.0), (20000, -12.0),
        ],
    },
}


def mic_profile_spectrum(profile_id: str, num_bands: int, sr: int = 48000) -> Tuple[np.ndarray, np.ndarray]:
    """Genera (centers, db) per un profilo microfono, sulla stessa griglia di
    bande log-spaziate usata da band_spectrum, cosi' e' intercambiabile con
    lo spettro di una traccia reale ovunque nel resto della pipeline."""
    profile = MIC_PROFILES.get(profile_id)
    if profile is None:
        raise ValueError(f"Profilo microfono sconosciuto: {profile_id}")

    edges = band_edges(sr, num_bands)
    centers = np.sqrt(edges[:-1] * edges[1:])

    bp_freqs = np.array([f for f, _ in profile["breakpoints"]], dtype=np.float64)
    bp_db = np.array([d for _, d in profile["breakpoints"]], dtype=np.float64)
    db = np.interp(np.log10(centers), np.log10(bp_freqs), bp_db)
    return centers, db


def measure_lufs(data: np.ndarray, sr: int) -> float:
    if HAVE_PYLOUDNORM:
        meter = pyln.Meter(sr)
        try:
            return float(meter.integrated_loudness(data))
        except Exception:
            pass
    # Fallback: stima RMS-based approssimata in stile-LUFS (non calibrata
    # con precisione ITU-R BS.1770, ma sufficiente per un gain di matching
    # relativo quando pyloudnorm non e' installato).
    mono = to_mono(data)
    rms = np.sqrt(np.mean(np.square(mono)) + EPS)
    return 20.0 * np.log10(rms + EPS) - 0.691


def peak_db(data: np.ndarray) -> float:
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    return 20.0 * np.log10(peak + EPS)


def smooth_curve(values: np.ndarray, window: int = 3) -> np.ndarray:
    if window <= 1 or len(values) < window:
        return values
    kernel = np.ones(window) / window
    padded = np.pad(values, (window // 2, window // 2), mode="edge")
    return np.convolve(padded, kernel, mode="valid")[: len(values)]


def build_gain_curve(
    ref_centers: np.ndarray,
    ref_db: np.ndarray,
    src_centers: np.ndarray,
    src_db: np.ndarray,
    max_boost_db: float,
    max_cut_db: float,
) -> np.ndarray:
    """Curva di guadagno (dB) da applicare alla sorgente = riferimento - sorgente,
    smussata e limitata in range per evitare artefatti.

    Importante: rimuoviamo prima l'offset di livello complessivo (mediana
    della differenza) cosi' che max_boost_db/max_cut_db limitino solo la
    correzione di *forma* spettrale (timbro), non un'eventuale differenza di
    guadagno assoluto tra i due microfoni - quella e' gia' compito separato
    del loudness matching (LUFS) applicato dopo il filtro. Senza questo
    passaggio, un semplice offset di preamp tra i due mic (comunissimo)
    satura l'intera curva al clamp e cancella la correzione per banda.
    """
    ref_interp = np.interp(src_centers, ref_centers, ref_db)
    delta = ref_interp - src_db
    level_offset = float(np.median(delta))
    shape_delta = delta - level_offset
    shape_delta = smooth_curve(shape_delta, window=3)
    return np.clip(shape_delta, -abs(max_cut_db), abs(max_boost_db))


def design_fir(centers: np.ndarray, gain_db: np.ndarray, sr: int, numtaps: int) -> np.ndarray:
    """Costruisce un filtro FIR a fase lineare (frequency-sampling) dalla
    curva di guadagno per banda, con scipy.signal.firwin2."""
    if numtaps % 2 == 0:
        numtaps += 1  # firwin2 con gain(nyquist)!=0 richiede taps dispari

    nyquist = sr / 2.0
    freq_hz = np.concatenate(([0.0], centers, [nyquist]))
    gain_db_ext = np.concatenate(([gain_db[0]], gain_db, [gain_db[-1]]))

    # Garantisce stretta monotonia richiesta da firwin2
    freq_hz = np.maximum.accumulate(freq_hz)
    freq_hz[0] = 0.0
    freq_hz[-1] = nyquist
    for i in range(1, len(freq_hz)):
        if freq_hz[i] <= freq_hz[i - 1]:
            freq_hz[i] = freq_hz[i - 1] + 1e-6

    gain_linear = 10.0 ** (gain_db_ext / 20.0)
    freq_norm = freq_hz / nyquist  # 0..1, fs implicito = 2

    return firwin2(numtaps, freq_norm, gain_linear, window="hamming")


def apply_fir(data: np.ndarray, fir: np.ndarray) -> np.ndarray:
    delay = (len(fir) - 1) // 2

    def _filter_1d(x: np.ndarray) -> np.ndarray:
        y = fftconvolve(x, fir, mode="full")
        y = y[delay: delay + len(x)]
        return y.astype(np.float32)

    if data.ndim == 1:
        return _filter_1d(data)
    return np.stack([_filter_1d(data[:, ch]) for ch in range(data.shape[1])], axis=1)


def smooth_gain_envelope(target_gain: np.ndarray, sr: int, attack_ms: float, release_ms: float) -> np.ndarray:
    """Inviluppo di gain con attacco rapido (anticipato/"lookahead") e
    rilascio graduale, condiviso da limiter e de-esser: invece di applicare
    la riduzione di gain campione per campione (che scatterebbe di colpo,
    causando artefatti), la tiene bassa per un breve periodo dopo ogni
    transiente e la fa risalire con una rampa smussata invece che a gradino.
    """
    attack = max(1, int(sr * attack_ms / 1000))
    release = max(1, int(sr * release_ms / 1000))

    attack_gain = minimum_filter1d(target_gain, size=attack * 2 + 1, mode="nearest")

    released = maximum_filter1d(attack_gain, size=release, mode="nearest")
    smooth_window = max(1, release // 4)
    if smooth_window > 1:
        kernel = np.ones(smooth_window) / smooth_window
        padded = np.pad(released, (smooth_window // 2, smooth_window // 2), mode="edge")
        released = np.convolve(padded, kernel, mode="valid")[: len(released)]

    gain = np.minimum(attack_gain, released)
    return np.minimum(gain, 1.0)


def true_peak_limiter(
    data: np.ndarray,
    sr: int,
    ceiling_db: float = -0.3,
    lookahead_ms: float = 5.0,
    release_ms: float = 80.0,
) -> np.ndarray:
    """Limiter con lookahead + release, invece di una normalizzazione lineare
    globale.

    La versione precedente, quando un singolo transiente superava la soglia
    di sicurezza, riduceva il gain di *tutto* il file in proporzione a quel
    picco isolato: risultato, un file percepito molto piu' silenzioso del
    riferimento nonostante il loudness matching avesse gia' calcolato il
    gain corretto (bug segnalato dall'utente). Qui invece il gain viene
    ridotto solo intorno ai transienti che superano la soglia - con un
    breve anticipo (lookahead) e un rilascio graduale (release) - cosi' il
    loudness medio resta il piu' vicino possibile al target.

    Non e' un limiter da mastering (niente vera curva knee/true-peak
    oversampling): e' volutamente semplice e vettorizzato per restare
    veloce su file lunghi, ma e' gia' molto piu' trasparente di uno scalare
    unico su tutto il file.
    """
    ceiling = 10.0 ** (ceiling_db / 20.0)
    peak_env = np.max(np.abs(data), axis=1) if data.ndim == 2 else np.abs(data)

    if float(np.max(peak_env)) <= ceiling:
        return data  # niente da limitare

    # gain massimo consentito campione per campione per non superare la soglia
    target_gain = np.minimum(1.0, ceiling / (peak_env + EPS))
    gain = smooth_gain_envelope(target_gain, sr, attack_ms=lookahead_ms, release_ms=release_ms)

    if data.ndim == 2:
        gain = gain[:, None]
    return (data * gain).astype(np.float32)


def _process_per_channel(data: np.ndarray, fn) -> np.ndarray:
    if data.ndim == 1:
        return fn(data).astype(np.float32)
    return np.stack([fn(data[:, ch]).astype(np.float32) for ch in range(data.shape[1])], axis=1)


def remove_rumble(data: np.ndarray, sr: int, cutoff_hz: float) -> np.ndarray:
    """Filtro passa-alto (anti-rimbombo/rumble) per ripulire ronzii a bassa
    frequenza - HVAC, traffico, colpi/vibrazioni sul microfono, effetto di
    prossimita' eccessivo. cutoff_hz <= 0 disattiva il filtro (bypass)."""
    if cutoff_hz <= 0:
        return data
    nyquist = sr / 2.0
    cutoff = min(cutoff_hz, nyquist * 0.9)
    sos = butter(4, cutoff, btype="highpass", fs=sr, output="sos")
    return _process_per_channel(data, lambda x: sosfiltfilt(sos, x))


def deess(
    data: np.ndarray,
    sr: int,
    amount: float,
    band: Tuple[float, float] = (4000.0, 9000.0),
) -> np.ndarray:
    """De-esser a banda separata: isola la banda sibilante (default 4-9kHz),
    ne misura l'inviluppo e riduce il gain SOLO in quella banda quando supera
    il livello "normale" del file - non e' un taglio EQ statico, che
    spegnerebbe anche le consonanti sibilanti normali e non solo i picchi
    fastidiosi. amount <= 0 disattiva il de-esser (bypass); amount in (0, 1]
    controlla sia quanto facilmente scatta (soglia) sia quanta riduzione
    massima puo' applicare.
    """
    if amount <= 0:
        return data
    amount = float(np.clip(amount, 0.0, 1.0))

    nyquist = sr / 2.0
    hi = min(band[1], nyquist * 0.95)
    if band[0] >= hi:
        return data  # sample rate troppo basso per isolare la banda sibilante

    sos = butter(4, [band[0], hi], btype="band", fs=sr, output="sos")
    sibilant_mono = sosfiltfilt(sos, to_mono(data))

    # inviluppo in dB su una finestra ~3ms: abbastanza rapida da inseguire
    # una "s" ma non i singoli cicli d'onda
    window = max(1, int(sr * 0.003))
    power_env = uniform_filter1d(sibilant_mono.astype(np.float64) ** 2, size=window)
    envelope_db = 10.0 * np.log10(power_env + EPS)

    # soglia e riduzione massima calibrate sul file stesso (mediana della
    # banda sibilante) invece che su un valore assoluto in dB: cosi' un
    # singolo knob funziona in modo simile a prescindere dal gain di
    # registrazione della sorgente.
    baseline_db = float(np.median(envelope_db))
    threshold_db = baseline_db + (6.0 - amount * 5.0)
    max_reduction_db = 4.0 + amount * 12.0

    excess_db = np.clip(envelope_db - threshold_db, 0.0, None)
    reduction_db = -np.minimum(excess_db, max_reduction_db)
    target_gain = 10.0 ** (reduction_db / 20.0)
    gain = smooth_gain_envelope(target_gain, sr, attack_ms=2.0, release_ms=60.0)

    def _process(x: np.ndarray) -> np.ndarray:
        band_signal = sosfiltfilt(sos, x)
        rest = x - band_signal
        return rest + band_signal * gain

    return _process_per_channel(data, _process)


def dereverb(data: np.ndarray, sr: int, amount: float) -> np.ndarray:
    """Riduzione (non rimozione) del riverbero via WPE (Weighted Prediction
    Error - libreria nara_wpe): un algoritmo statistico che modella la coda
    riverberante come la parte "prevedibile" del segnale a partire dal
    segnale stesso ritardato, e la sottrae.

    Limite onesto, verificato empiricamente durante lo sviluppo (non solo
    dichiarato): su una singola traccia mono - il caso comune qui, una voce
    isolata senza diversita' spaziale multi-canale - l'effetto e' reale ma
    MODESTO: qualche dB di riduzione della coda, non una "asciugatura"
    drastica della stanza. Impostazioni piu' aggressive dell'algoritmo NON
    aiutano: nei test hanno eroso il parlato diretto quasi quanto la coda
    riverberante, peggiorando (non migliorando) la somiglianza col segnale
    secco di riferimento. Per questo i parametri dell'algoritmo
    (taps/delay/iterazioni) sono fissi e calibrati sul punto di rendimento
    migliore trovato, e `amount` controlla solo un blend secco/processato -
    non spinge l'algoritmo oltre la sua zona utile.

    amount <= 0 disattiva il de-reverb (bypass, nessun costo computazionale).
    """
    if amount <= 0:
        return data
    if not HAVE_NARA_WPE:
        raise RuntimeError(
            "nara_wpe non e' installato: esegui 'pip install -r requirements.txt' "
            "nel venv per abilitare la riduzione del riverbero."
        )
    amount = float(np.clip(amount, 0.0, 1.0))

    hop_ms, win_ms = 8.0, 32.0
    shift = max(32, round(sr * hop_ms / 1000))
    size = max(64, round(sr * win_ms / 1000))
    size += size % 2  # nara_wpe richiede una dimensione FFT pari

    def _process(x: np.ndarray) -> np.ndarray:
        n = len(x)
        Y = _wpe_utils.stft(x[None, :], size=size, shift=shift, axis=-1)
        Y_in = Y.transpose(2, 0, 1)  # (freq, canali=1, frame)
        Z = _wpe(Y_in, taps=20, delay=3, iterations=8, psd_context=3)
        y_out = _wpe_utils.istft(Z.transpose(1, 2, 0), size=size, shift=shift)[0]
        y_out = y_out.astype(np.float32)
        if len(y_out) < n:
            y_out = np.pad(y_out, (0, n - len(y_out)))
        else:
            y_out = y_out[:n]
        return x * (1.0 - amount) + y_out * amount

    return _process_per_channel(data, _process)


# ---------------------------------------------------------------------------
# Azioni
# ---------------------------------------------------------------------------

def action_analyze(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = payload["path"]
    emit_progress(10, "load", f"Carico {Path(path).name}")
    data, sr = load_audio(path)
    check_audio_usable(data, sr, Path(path).name)
    mono = to_mono(data)

    emit_progress(50, "spectrum", "Calcolo spettro")
    centers, db = band_spectrum(mono, sr, num_bands=31)

    emit_progress(80, "loudness", "Misuro loudness")
    lufs = measure_lufs(data, sr)

    duration = len(mono) / sr if sr else 0.0
    channels = 1 if data.ndim == 1 else data.shape[1]

    emit_progress(100, "done", "Analisi completata")
    return {
        "duration": duration,
        "sample_rate": sr,
        "channels": channels,
        "lufs": lufs,
        "peak_db": peak_db(data),
        "spectrum": {"freqs": centers.tolist(), "db": db.tolist()},
    }


def action_list_mic_profiles(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "profiles": [
            {"id": pid, "name": p["name"], "note": p.get("note", "")}
            for pid, p in MIC_PROFILES.items()
        ]
    }


def action_mic_profile_spectrum(payload: Dict[str, Any]) -> Dict[str, Any]:
    profile_id = payload["profile_id"]
    num_bands = int(payload.get("num_bands", 31))
    centers, db = mic_profile_spectrum(profile_id, num_bands)
    return {"spectrum": {"freqs": centers.tolist(), "db": db.tolist()}}


def action_match(payload: Dict[str, Any]) -> Dict[str, Any]:
    reference_mode = payload.get("reference_mode", "track")
    target_paths: List[str] = payload["target_paths"]
    output_dir = Path(payload["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    config = payload.get("config", {}) or {}
    max_boost_db = float(config.get("max_boost_db", 6.0))
    max_cut_db = float(config.get("max_cut_db", 12.0))
    num_bands = int(config.get("num_bands", 31))
    # "reference" (LUFS della traccia di riferimento), "none" (disattivato)
    # oppure un numero (target LUFS assoluto, es. da uno standard broadcast/
    # streaming scelto nel selettore) - vedi RESULT["results"][i]["loudness_gain_db"].
    loudness_target = config.get("loudness_target", "reference")
    fir_taps = int(config.get("fir_taps", 2047))
    blend = float(np.clip(config.get("blend", 1.0), 0.0, 1.0))
    ceiling_db = float(config.get("ceiling_db", -0.3))
    rumble_hz = float(config.get("rumble_hz", 0.0))
    deess_amount = float(np.clip(config.get("deess_amount", 0.0), 0.0, 1.0))
    dereverb_amount = float(np.clip(config.get("dereverb_amount", 0.0), 0.0, 1.0))

    total_steps = len(target_paths) + 1
    step = 0

    if reference_mode == "mic_profile":
        mic_profile_id = payload["mic_profile"]
        profile_name = MIC_PROFILES[mic_profile_id]["name"]
        emit_progress(0, "reference", f"Uso il profilo microfono: {profile_name}")
        ref_centers, ref_db = mic_profile_spectrum(mic_profile_id, num_bands)
        ref_lufs = None
        # Un profilo microfono e' solo una curva di forma spettrale: non
        # esiste un loudness "di riferimento" da inseguire. Se arriva
        # comunque "reference" (safety net, il client dovrebbe gia' evitarlo)
        # lo declassiamo a "none" invece di inventare un target arbitrario -
        # un target numerico esplicito (standard broadcast/streaming) resta
        # invece valido anche in questa modalita'.
        if loudness_target == "reference":
            loudness_target = "none"
        step += 1
        emit_progress(100 * step / total_steps, "reference", "Profilo microfono pronto")
    else:
        reference_path = payload["reference_path"]
        emit_progress(0, "reference", f"Analizzo riferimento: {Path(reference_path).name}")
        ref_data, ref_sr = load_audio(reference_path)
        check_audio_usable(ref_data, ref_sr, Path(reference_path).name)
        ref_mono = to_mono(ref_data)
        ref_centers, ref_db = band_spectrum(ref_mono, ref_sr, num_bands)
        ref_lufs = measure_lufs(ref_data, ref_sr)
        step += 1
        emit_progress(100 * step / total_steps, "reference", "Riferimento analizzato")

    results = []
    for target_path in target_paths:
        name = Path(target_path).name
        emit_progress(100 * step / total_steps, "load", f"Carico {name}")
        src_data, src_sr = load_audio(target_path)
        check_audio_usable(src_data, src_sr, name)

        if rumble_hz > 0:
            emit_progress(100 * step / total_steps, "rumble", f"Filtro anti-rimbombo: {name}")
            src_data = remove_rumble(src_data, src_sr, rumble_hz)

        if dereverb_amount > 0:
            emit_progress(100 * step / total_steps, "dereverb", f"Riduzione riverbero: {name}")
            src_data = dereverb(src_data, src_sr, dereverb_amount)

        src_mono = to_mono(src_data)

        emit_progress(100 * step / total_steps, "spectrum", f"Analizzo spettro: {name}")
        src_centers, src_db = band_spectrum(src_mono, src_sr, num_bands)

        emit_progress(100 * step / total_steps, "curve", f"Calcolo curva EQ: {name}")
        gain_curve_db = build_gain_curve(
            ref_centers, ref_db, src_centers, src_db, max_boost_db, max_cut_db
        )
        gain_curve_db = gain_curve_db * blend  # "intensita' del matching": 0 = bypass, 1 = correzione piena

        emit_progress(100 * step / total_steps, "filter", f"Applico EQ: {name}")
        fir = design_fir(src_centers, gain_curve_db, src_sr, fir_taps)
        filtered = apply_fir(src_data, fir)

        if deess_amount > 0:
            emit_progress(100 * step / total_steps, "deess", f"De-esser: {name}")
            filtered = deess(filtered, src_sr, deess_amount)

        loudness_gain_db = 0.0
        lufs_before = measure_lufs(src_data, src_sr)

        target_lufs: Optional[float] = None
        if loudness_target == "reference":
            target_lufs = ref_lufs
        elif loudness_target != "none":
            target_lufs = float(loudness_target)

        if target_lufs is not None:
            emit_progress(100 * step / total_steps, "loudness", f"Adatto loudness: {name}")
            filtered_lufs = measure_lufs(filtered, src_sr)
            loudness_gain_db = (target_lufs - filtered_lufs) * blend
            filtered = filtered * (10.0 ** (loudness_gain_db / 20.0))

        emit_progress(100 * step / total_steps, "limiter", f"Controllo picchi: {name}")
        filtered = true_peak_limiter(filtered, src_sr, ceiling_db=ceiling_db)
        lufs_after = measure_lufs(filtered, src_sr)

        out_path = output_dir / f"{Path(target_path).stem}_matched.wav"
        sf.write(str(out_path), filtered, src_sr, subtype="PCM_24")

        after_centers, after_db = band_spectrum(to_mono(filtered), src_sr, num_bands)

        results.append({
            "source_path": target_path,
            "output_path": str(out_path),
            "spectrum_before": {"freqs": src_centers.tolist(), "db": src_db.tolist()},
            "spectrum_after": {"freqs": after_centers.tolist(), "db": after_db.tolist()},
            "gain_curve": {"freqs": src_centers.tolist(), "db": gain_curve_db.tolist()},
            "lufs_before": lufs_before,
            "lufs_after": lufs_after,
            "loudness_gain_db": loudness_gain_db,
        })

        step += 1
        emit_progress(100 * step / total_steps, "done", f"Completato: {name}")

    return {
        "reference": {
            "spectrum": {"freqs": ref_centers.tolist(), "db": ref_db.tolist()},
            "lufs": ref_lufs,
        },
        "results": results,
    }


ACTIONS = {
    "analyze": action_analyze,
    "list_mic_profiles": action_list_mic_profiles,
    "mic_profile_spectrum": action_mic_profile_spectrum,
    "match": action_match,
}


def main() -> int:
    raw = sys.stdin.readline()
    if not raw.strip():
        emit_error("Nessun input ricevuto su stdin")
        return 1
    try:
        payload = json.loads(raw)
        action = payload.get("action")
        handler = ACTIONS.get(action)
        if handler is None:
            emit_error(f"Azione sconosciuta: {action}")
            return 1
        result = handler(payload)
        emit_result(result)
        return 0
    except Exception as exc:  # noqa: BLE001 - vogliamo sempre riportare l'errore al processo padre
        emit_error(friendly_error_message(exc), details=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
