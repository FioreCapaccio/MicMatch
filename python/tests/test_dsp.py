"""
Test del motore DSP di MicMatch (python/mic_match.py).

Non sono test di "qualita' audio soggettiva" (impossibile da automatizzare
in modo sensato) ma test di REGRESSIONE su comportamenti gia' verificati a
mano durante lo sviluppo, in particolare il bug reale trovato una volta
(il limiter che spegneva il volume di interi file per colpa di un singolo
picco) - lo scopo e' che una futura modifica non lo faccia ricomparire in
silenzio.

Esegui con:
    python/venv/bin/pytest python/tests/
"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

import mic_match as mm


SR = 44100


# ---------------------------------------------------------------------------
# Helper per generare segnali sintetici di test
# ---------------------------------------------------------------------------

def bandpass_noise(rng, n, sr, lo, hi):
    sos = butter(4, [lo, hi], btype="band", fs=sr, output="sos")
    return sosfilt(sos, rng.normal(0, 1, n)).astype(np.float32)


def sine(freq, seconds, sr=SR, amplitude=0.2):
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    return (np.sin(2 * np.pi * freq * t) * amplitude).astype(np.float32)


# ---------------------------------------------------------------------------
# build_gain_curve: il bug originale era che un offset di livello costante
# tra due mic (comunissimo: preamp diversi) saturava l'INTERA curva al
# clamp massimo, cancellando la correzione di forma spettrale banda per
# banda. Il fix rimuove la mediana prima di applicare il clamp.
# ---------------------------------------------------------------------------

class TestBuildGainCurve:
    def test_shape_preserved_despite_constant_offset(self):
        centers = np.logspace(np.log10(100), np.log10(10000), 20)
        # riferimento sempre a 0dB, sorgente 20dB piu' silenziosa OVUNQUE
        # (offset costante) TRANNE in una banda dove e' molto piu' vicina.
        ref_db = np.zeros_like(centers)
        src_db = np.full_like(centers, -20.0)
        src_db[10] = -2.0  # questa banda ha un delta molto piu' piccolo

        curve = mm.build_gain_curve(centers, ref_db, centers, src_db, max_boost_db=6.0, max_cut_db=12.0)

        # se il bug fosse ancora presente, TUTTA la curva sarebbe piatta al
        # boost massimo (6.0) - la banda 10 deve invece distinguersi dalle
        # altre, riflettendo che li' serve MENO boost relativo.
        assert not np.allclose(curve, curve[0]), "la curva e' piatta: l'offset di livello sta di nuovo saturando tutto"
        assert curve[10] < curve[0] - 1.0, "la banda con delta minore dovrebbe ricevere meno boost relativo"

    def test_clamped_within_bounds(self):
        centers = np.logspace(np.log10(100), np.log10(10000), 20)
        ref_db = np.zeros_like(centers)
        src_db = np.full_like(centers, -50.0)
        curve = mm.build_gain_curve(centers, ref_db, centers, src_db, max_boost_db=6.0, max_cut_db=12.0)
        assert np.all(curve <= 6.0 + 1e-9)
        assert np.all(curve >= -12.0 - 1e-9)


# ---------------------------------------------------------------------------
# true_peak_limiter: non deve piu' comportarsi come una normalizzazione
# lineare globale (il bug segnalato dall'utente: un picco isolato abbassava
# il volume di TUTTO il file).
# ---------------------------------------------------------------------------

class TestTruePeakLimiter:
    def test_respects_ceiling(self):
        rng = np.random.default_rng(0)
        data = bandpass_noise(rng, SR * 2, SR, 200, 4000) * 0.3
        data[SR] += 0.9  # transiente isolato molto sopra la soglia
        out = mm.true_peak_limiter(data, SR, ceiling_db=-0.3)
        ceiling = 10 ** (-0.3 / 20)
        assert np.max(np.abs(out)) <= ceiling * 1.001

    def test_does_not_crush_signal_away_from_the_peak(self):
        rng = np.random.default_rng(0)
        data = bandpass_noise(rng, SR * 2, SR, 200, 4000) * 0.3
        data[SR] += 0.9  # un solo transiente isolato a meta' file
        out = mm.true_peak_limiter(data, SR, ceiling_db=-0.3)

        # lontano dal transiente (es. il primo mezzo secondo) il segnale
        # deve restare sostanzialmente invariato: se il bug fosse tornato,
        # qui il volume sarebbe crollato insieme al resto del file.
        untouched_before = data[: int(SR * 0.5)]
        untouched_after = out[: int(SR * 0.5)]
        rms_before = np.sqrt(np.mean(untouched_before ** 2))
        rms_after = np.sqrt(np.mean(untouched_after ** 2))
        assert rms_after > rms_before * 0.95

    def test_bypass_when_already_under_ceiling(self):
        rng = np.random.default_rng(0)
        data = bandpass_noise(rng, SR, SR, 200, 4000) * 0.1
        out = mm.true_peak_limiter(data, SR, ceiling_db=-0.3)
        assert np.array_equal(data, out)


# ---------------------------------------------------------------------------
# deess: riduzione dinamica solo nella banda sibilante, non un taglio EQ
# statico su tutto il file.
# ---------------------------------------------------------------------------

class TestDeess:
    def test_reduces_sibilant_burst(self):
        rng = np.random.default_rng(2)
        n = SR * 2
        base = bandpass_noise(rng, n, SR, 200, 3000) * 0.1
        sib_start, sib_len = SR, int(SR * 0.15)
        sibilant = bandpass_noise(rng, sib_len, SR, 5000, 8000) * 0.5
        base[sib_start:sib_start + sib_len] += sibilant

        out = mm.deess(base, SR, amount=0.8)

        def band_rms(x, lo, hi):
            sos = butter(4, [lo, hi], btype="band", fs=SR, output="sos")
            y = sosfilt(sos, x)
            return float(np.sqrt(np.mean(y[sib_start:sib_start + sib_len] ** 2)))

        before = band_rms(base, 5000, 8000)
        after = band_rms(out, 5000, 8000)
        assert after < before * 0.7, "il de-esser dovrebbe ridurre sensibilmente l'energia nella banda sibilante"

    def test_bypass_when_amount_zero(self):
        rng = np.random.default_rng(2)
        data = bandpass_noise(rng, SR, SR, 200, 3000) * 0.1
        out = mm.deess(data, SR, amount=0.0)
        assert np.array_equal(data, out)


# ---------------------------------------------------------------------------
# remove_rumble: passa-alto, deve attenuare sotto il cutoff e preservare
# sopra.
# ---------------------------------------------------------------------------

class TestRemoveRumble:
    def test_attenuates_below_cutoff_preserves_above(self):
        rng = np.random.default_rng(3)
        low = bandpass_noise(rng, SR * 2, SR, 20, 60) * 0.3
        high = bandpass_noise(rng, SR * 2, SR, 500, 3000) * 0.1
        data = low + high

        out = mm.remove_rumble(data, SR, cutoff_hz=100)

        def band_rms(x, lo, hi):
            sos = butter(4, [lo, hi], btype="band", fs=SR, output="sos")
            y = sosfilt(sos, x)
            return float(np.sqrt(np.mean(y ** 2)))

        low_before, low_after = band_rms(data, 20, 60), band_rms(out, 20, 60)
        high_before, high_after = band_rms(data, 500, 3000), band_rms(out, 500, 3000)

        assert low_after < low_before * 0.1, "il rimbombo sotto il cutoff dovrebbe crollare"
        assert high_after > high_before * 0.9, "il contenuto sopra il cutoff non dovrebbe essere toccato"

    def test_bypass_when_cutoff_zero_or_negative(self):
        rng = np.random.default_rng(3)
        data = bandpass_noise(rng, SR, SR, 20, 3000) * 0.2
        assert np.array_equal(data, mm.remove_rumble(data, SR, cutoff_hz=0))
        assert np.array_equal(data, mm.remove_rumble(data, SR, cutoff_hz=-10))


# ---------------------------------------------------------------------------
# dereverb: bypass economico sempre testato; un passaggio "vero" con WPE e'
# piu' lento quindi limitato a un file breve, solo per verificare che non
# esploda e non produca NaN/Inf - il livello di riduzione del riverbero e'
# gia' stato validato a mano (vedi il commento nella funzione).
# ---------------------------------------------------------------------------

class TestDereverb:
    def test_bypass_when_amount_zero(self):
        rng = np.random.default_rng(4)
        data = bandpass_noise(rng, SR, SR, 200, 3000) * 0.1
        out = mm.dereverb(data, SR, amount=0.0)
        assert np.array_equal(data, out)

    @pytest.mark.skipif(not mm.HAVE_NARA_WPE, reason="nara_wpe non installato in questo interprete")
    def test_runs_without_crashing_on_short_audio(self):
        rng = np.random.default_rng(4)
        data = bandpass_noise(rng, int(SR * 1.5), SR, 200, 3000) * 0.1
        out = mm.dereverb(data, SR, amount=0.5)
        assert out.shape == data.shape
        assert np.all(np.isfinite(out))


# ---------------------------------------------------------------------------
# mic_profile_spectrum: sanita' delle curve indicative dei profili
# microfono.
# ---------------------------------------------------------------------------

class TestMicProfileSpectrum:
    @pytest.mark.parametrize("profile_id", list(mm.MIC_PROFILES.keys()))
    def test_returns_finite_monotonic_freqs(self, profile_id):
        centers, db = mm.mic_profile_spectrum(profile_id, num_bands=31)
        assert len(centers) == len(db) == 31
        assert np.all(np.isfinite(db))
        assert np.all(np.diff(centers) > 0), "le frequenze centrali devono essere strettamente crescenti"

    def test_unknown_profile_raises_value_error(self):
        with pytest.raises(ValueError):
            mm.mic_profile_spectrum("profilo-inesistente", num_bands=31)


# ---------------------------------------------------------------------------
# Casi limite: file troppo corti o silenziosi devono fallire presto con un
# messaggio chiaro, non in profondita' nella pipeline con un errore
# numpy/scipy incomprensibile.
# ---------------------------------------------------------------------------

class TestAudioGuards:
    def test_rejects_too_short(self):
        data = np.zeros(int(SR * 0.05), dtype=np.float32)  # 50ms < soglia 100ms
        with pytest.raises(ValueError, match="troppo corto"):
            mm.check_audio_usable(data, SR, "prova.wav")

    def test_rejects_silence(self):
        data = np.zeros(SR * 2, dtype=np.float32)  # abbastanza lungo ma muto
        with pytest.raises(ValueError, match="silenzioso"):
            mm.check_audio_usable(data, SR, "prova.wav")

    def test_accepts_normal_audio(self):
        data = sine(300, 1.0)
        mm.check_audio_usable(data, SR, "prova.wav")  # non deve sollevare nulla

    def test_load_audio_missing_file_raises_filenotfound(self, tmp_path):
        missing = tmp_path / "non_esiste.wav"
        with pytest.raises(FileNotFoundError):
            mm.load_audio(str(missing))

    def test_load_audio_roundtrip(self, tmp_path):
        path = tmp_path / "ok.wav"
        data = sine(300, 0.5)
        sf.write(str(path), data, SR, subtype="PCM_24")
        loaded, sr = mm.load_audio(str(path))
        assert sr == SR
        assert len(loaded) == len(data)


# ---------------------------------------------------------------------------
# friendly_error_message: mappatura delle eccezioni comuni verso messaggi
# comprensibili (vedi python/mic_match.py per il contesto del bug che ha
# motivato questo - prima si vedeva il traceback grezzo in UI).
# ---------------------------------------------------------------------------

class TestStereoHandling:
    """I filtri per-canale (rumble/deess/limiter) vengono usati sia su
    materiale mono sia stereo (es. registrazioni gia' stereo o doppio
    canale identico): verifica che una shape (n, 2) non li faccia esplodere
    e che il canale destro non contamini il sinistro o viceversa."""

    def _stereo(self, rng):
        left = bandpass_noise(rng, SR, SR, 200, 3000) * 0.2
        right = bandpass_noise(rng, SR, SR, 200, 3000) * 0.05  # canali diversi apposta
        return np.stack([left, right], axis=1)

    def test_remove_rumble_preserves_shape_and_channel_independence(self):
        rng = np.random.default_rng(5)
        data = self._stereo(rng)
        out = mm.remove_rumble(data, SR, cutoff_hz=100)
        assert out.shape == data.shape
        assert not np.allclose(out[:, 0], out[:, 1])

    def test_true_peak_limiter_preserves_shape(self):
        rng = np.random.default_rng(5)
        data = self._stereo(rng)
        data[SR // 2] = [0.95, 0.95]
        out = mm.true_peak_limiter(data, SR, ceiling_db=-0.3)
        assert out.shape == data.shape
        assert np.max(np.abs(out)) <= 10 ** (-0.3 / 20) * 1.001

    def test_deess_preserves_shape(self):
        rng = np.random.default_rng(5)
        data = self._stereo(rng)
        out = mm.deess(data, SR, amount=0.5)
        assert out.shape == data.shape


class TestFriendlyErrorMessage:
    def test_value_error_passthrough(self):
        exc = ValueError("messaggio gia' scritto per l'utente")
        assert mm.friendly_error_message(exc) == str(exc)

    def test_file_not_found(self):
        msg = mm.friendly_error_message(FileNotFoundError("/tmp/x.wav"))
        assert "non trovato" in msg.lower()

    def test_permission_error(self):
        msg = mm.friendly_error_message(PermissionError("denied"))
        assert "permesso negato" in msg.lower()

    def test_generic_fallback_is_not_a_raw_traceback(self):
        msg = mm.friendly_error_message(RuntimeError("qualcosa di specifico e tecnico"))
        assert "qualcosa di specifico e tecnico" not in msg
        assert len(msg) < 200
