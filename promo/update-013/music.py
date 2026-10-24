"""Deterministic instrumental score: drums, bass, chords and stereo arpeggio."""
import argparse
import json
import subprocess
import wave
from pathlib import Path

import numpy as np


def compose(duration, cues, output, ffmpeg):
    sr = 48000
    count = round(duration * sr)
    score = np.zeros((count, 2), dtype=np.float64)
    rng = np.random.default_rng(13)
    beat = 60 / 120
    # C minor / Ab / Eb / Bb: a complete four-bar instrumental phrase.
    chords = ((48, 51, 55, 58), (44, 48, 51, 55),
              (46, 51, 55, 58), (46, 50, 53, 58))

    def add(at, signal, gain, pan=0):
        start = round(at * sr)
        if start >= count:
            return
        signal = signal[:count - start] * gain
        score[start:start + len(signal), 0] += signal * np.sqrt((1 - pan) / 2)
        score[start:start + len(signal), 1] += signal * np.sqrt((1 + pan) / 2)

    for step in range(int(np.ceil(duration / (beat / 2)))):
        at = step * beat / 2
        bar = int(at / (4 * beat))
        chord = chords[bar % 4]
        # A small breakdown before the 0.1.3 impact card gives the return weight.
        breakdown = 24 <= at < 26.65
        lift = .42 if at < 3.9 else (.25 if breakdown else 1)
        if step % 2 == 0 and not breakdown:
            t = np.arange(round(.32 * sr)) / sr
            phase = 2 * np.pi * (43 * t + 100 * .027 * (1 - np.exp(-t / .027)))
            kick = np.sin(phase) * np.exp(-t / .075)
            add(at, kick, .54 * lift)
        if step % 8 in (2, 6) and not breakdown:
            t = np.arange(round(.16 * sr)) / sr
            noise = rng.normal(0, 1, len(t))
            snare = (.65 * np.diff(noise, prepend=0) + .22 * np.sin(2 * np.pi * 185 * t))
            snare *= np.exp(-t / .035)
            add(at, snare, .105 * lift)
        if step % 2:
            t = np.arange(round(.055 * sr)) / sr
            hat = np.diff(rng.normal(0, 1, len(t)), prepend=0) * np.exp(-t / .012)
            add(at, hat, .035 * lift, -.25 if step % 4 == 1 else .25)

        midi = chord[(0, 2, 1, 3, 2, 1, 3, 2)[step % 8]] + 12
        freq = 440 * 2 ** ((midi - 69) / 12)
        t = np.arange(round(.65 * sr)) / sr
        pluck = (np.sin(2 * np.pi * freq * t)
                 + .3 * np.sin(2 * np.pi * 2 * freq * t)
                 + .12 * np.sin(2 * np.pi * 3 * freq * t))
        pluck *= (1 - np.exp(-t / .006)) * np.exp(-t / .18)
        pan = -.48 if step % 2 else .48
        add(at, pluck, .115 * (.55 if breakdown else 1), pan)
        add(at + beat * .75, pluck, .037, -pan)

        if step % 2 == 0:
            t = np.arange(round(.32 * sr)) / sr
            freq = 440 * 2 ** ((chord[0] - 12 - 69) / 12)
            bass = (np.sin(2 * np.pi * freq * t) + .22 * np.sin(2 * np.pi * freq * 2 * t))
            bass *= (1 - np.exp(-t / .008)) * np.exp(-t / .15)
            add(at + .035, bass, .23 * lift)

        if step % 8 == 0:
            t = np.arange(round(2.15 * sr)) / sr
            pad = np.zeros(len(t))
            for midi in chord:
                freq = 440 * 2 ** ((midi - 69) / 12)
                pad += np.sin(2 * np.pi * freq * t) / len(chord)
            pad *= np.minimum(t / .24, 1) * np.minimum((2.15 - t) / .5, 1)
            add(at, pad, .11)

    for cue in cues[1:]:
        at = float(cue['start'])
        t = np.arange(round(.14 * sr)) / sr
        click = np.sin(2 * np.pi * (840 * t - 950 * t * t)) * np.exp(-t / .035)
        add(at, click, .055)
    t = np.arange(count) / sr
    score *= (np.minimum(t / .12, 1) * np.minimum((duration - t) / 1.1, 1))[:, None]
    score = np.tanh(score * 1.35)
    score *= .88 / max(float(np.max(np.abs(score))), 1e-9)
    raw = output.with_name(output.stem + '-raw.wav')
    with wave.open(str(raw), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((score * 32767).astype('<i2').tobytes())
    subprocess.run([ffmpeg, '-y', '-v', 'error', '-i', str(raw),
                    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=8', '-ar', str(sr),
                    '-c:a', 'pcm_s16le', str(output)], check=True)
    raw.unlink()
    return dict(type='program-synthesized instrumental', voice=False,
                bpm=120, seed=13, sample_rate=sr, target_lufs=-16)


if __name__ == '__main__':
    import imageio_ffmpeg
    parser = argparse.ArgumentParser()
    parser.add_argument('--timeline', type=Path, default=Path(__file__).with_name('timeline.json'))
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    timeline = json.loads(args.timeline.read_text(encoding='utf-8'))
    print(json.dumps(compose(timeline['duration_seconds'], timeline['subtitles'],
                            args.out, imageio_ffmpeg.get_ffmpeg_exe())))
