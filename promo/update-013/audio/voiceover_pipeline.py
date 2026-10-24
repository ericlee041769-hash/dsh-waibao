#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Reproducible offline Chinese voiceover for the dsh-waibao 0.1.3 update film.

Engine: Windows System.Speech (SAPI 5), SSML per sentence. No network is used and
there is no automatic fallback: any missing voice, failed sentence or unreadable
loudness measurement stops the run.

Steps
  1. write build/spec.json from the narration spec embedded below
  2. render every sentence with synth_sapi.ps1 (48 kHz 16-bit mono PCM)
  3. trim each sentence, lay the 12 sentences out with their pauses
  4. loudness-normalise (ffmpeg loudnorm I=-16 TP=-1.5), measure with ebur128
  5. emit voiceover.wav (PCM s16le 48 kHz stereo), narration.json, captions.srt

Run (Windows, from anywhere):
  D:/conda/py310/python.exe promo/update-013/audio/voiceover_pipeline.py

Requires: Windows PowerShell 7+ on PATH (pwsh), D:/conda/py310 with numpy and
imageio_ffmpeg. All paths are resolved relative to this file.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
PARTS = BUILD / "parts"
SPEC = BUILD / "spec.json"

SR = 48000
VOICE = "Microsoft Huihui Desktop"
LEAD_IN = 0.2          # silence before the first sentence
TAIL = 0.7             # silence after the last sentence
LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"

# (tts text, on-screen subtitle, pause after in s, SSML rate, SSML pitch)
LINES = [
    ("我把任务交给AI，自己还得守着等回信。", "我把任务交给 AI，自己还得守着等回信。", 0.16, "+8%", "+0%"),
    ("这次，我把它改成了一支能沟通的小队。", "这次，我把它改成了一支能沟通的小队。", 0.20, "+14%", "+4%"),
    ("三个任务，同时开工。", "三个任务，同时开工。", 0.15, "+18%", "+4%"),
    ("发现问题，子代理直接汇报；", "发现问题，子代理直接汇报；", 0.13, "+12%", "+0%"),
    ("方向有变，父任务马上回复。", "方向有变，父任务马上回复。", 0.15, "+16%", "+4%"),
    ("一个跑偏？单独停掉，其他继续。", "一个跑偏？单独停掉，其他继续。", 0.24, "+15%", "+4%"),
    ("模型随你接，插件不设名单。", "模型随你接，插件不设名单。", 0.17, "+12%", "+0%"),
    ("前几版，补齐了会话续接、完成回调、审批问答；", "前几版，补齐了会话续接、完成回调、审批问答；", 0.15, "+16%", "+0%"),
    ("这一次，再加上并行和双向消息。", "这一次，再加上并行和双向消息。", 0.20, "+14%", "+0%"),
    ("真测三任务并发，六条消息，两次回复，全部接通。", "真测三任务并发，六条消息，两次回复，全部接通。", 0.18, "+15%", "+4%"),
    ("DSH外包，零点一点三，MIT开源。", "dsh-waibao 0.1.3，MIT 开源。", 0.20, "+10%", "+0%"),
    ("任务交得出去，过程也接得回来。", "任务交得出去，过程也接得回来。", 0.0, "+6%", "+0%"),
]


def ffmpeg() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def write_spec() -> Path:
    BUILD.mkdir(parents=True, exist_ok=True)
    spec = {
        "voice": VOICE,
        "lines": [
            {"index": i + 1, "tts": tts, "display": display, "gap": gap,
             "rate": rate, "pitch": pitch}
            for i, (tts, display, gap, rate, pitch) in enumerate(LINES)
        ],
    }
    SPEC.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
    return SPEC


def synth(spec_path: Path) -> Path:
    PARTS.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["pwsh", "-NoProfile", "-File", str(HERE / "synth_sapi.ps1"),
         "-Spec", str(spec_path), "-OutDir", str(PARTS)],
        check=True,
    )
    return PARTS


def read_part(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as stream:
        if (stream.getframerate() != SR or stream.getnchannels() != 1
                or stream.getsampwidth() != 2):
            raise RuntimeError(
                "Unexpected speech format in %s: %d Hz, %d ch, %d bytes"
                % (path, stream.getframerate(), stream.getnchannels(), stream.getsampwidth())
            )
        raw = stream.readframes(stream.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0


def trim(samples: np.ndarray, index: int) -> np.ndarray:
    audible = np.flatnonzero(np.abs(samples) > 10 ** (-45 / 20))
    if not len(audible):
        raise RuntimeError("Sentence %d is silent" % index)
    pad = int(SR * 0.03)
    return samples[max(0, audible[0] - pad):min(len(samples), audible[-1] + pad)]


def measure_loudness(path: Path) -> dict:
    """Integrated loudness / LRA / true peak from ffmpeg ebur128 (stderr summary)."""
    proc = subprocess.run(
        [ffmpeg(), "-hide_banner", "-nostats", "-i", str(path),
         "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("ebur128 measurement failed:\n" + proc.stderr[-2000:])
    if "Summary:" not in proc.stderr:
        raise RuntimeError("ebur128 produced no summary; cannot measure loudness")
    summary = proc.stderr.rsplit("Summary:", 1)[-1]
    lufs = re.search(r"I:\s*(-?[\d.]+)\s*LUFS", summary)
    lra = re.search(r"LRA:\s*(-?[\d.]+)\s*LU", summary)
    peak = re.search(r"Peak:\s*(-?[\d.]+)\s*dBFS", summary)
    if not lufs or not peak:
        raise RuntimeError("Cannot parse loudness from ffmpeg ebur128 summary:\n" + summary)
    return {
        "integrated_lufs": float(lufs.group(1)),
        "loudness_range_lu": float(lra.group(1)) if lra else None,
        "true_peak_dbfs": float(peak.group(1)),
    }


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as stream:
        stream.setparams((2, 2, SR, 0, "NONE", "not compressed"))
        stereo = np.repeat(samples[:, None], 2, axis=1)
        stream.writeframes(np.round(np.clip(stereo, -1, 1) * 32767).astype("<i2").tobytes())


def srt_time(seconds: float) -> str:
    ms = round(seconds * 1000)
    return "%02d:%02d:%02d,%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the 0.1.3 update-film Chinese voiceover.")
    ap.add_argument("--assemble-only", action="store_true",
                    help="reuse already rendered build/parts/*.wav instead of calling SAPI")
    args = ap.parse_args()

    spec_path = write_spec()
    if not args.assemble_only:
        synth(spec_path)

    clips = [trim(read_part(PARTS / ("s%02d.wav" % (i + 1))), i + 1) for i in range(len(LINES))]

    cursor = LEAD_IN
    cues = []
    for index, (clip, line) in enumerate(zip(clips, LINES), 1):
        end = cursor + len(clip) / SR
        cues.append({
            "index": index,
            "text": line[1],
            "tts_text": line[0],
            "start": round(cursor, 3),
            "end": round(end, 3),
            "duration": round(end - cursor, 3),
        })
        cursor = end + line[2]
    duration = cursor + TAIL

    samples = np.zeros(round(duration * SR), dtype=np.float64)
    for cue, clip in zip(cues, clips):
        offset = round(cue["start"] * SR)
        samples[offset:offset + len(clip)] = clip
    peak = float(np.max(np.abs(samples)))
    if peak >= 1.0:
        raise RuntimeError("Narration clips before loudness normalisation")
    samples *= min(1.0, 0.84 / peak)

    raw = BUILD / "voiceover-raw.wav"
    final = HERE / "voiceover.wav"
    write_wav(raw, samples)
    subprocess.run(
        [ffmpeg(), "-v", "error", "-y", "-i", str(raw), "-af", LOUDNORM,
         "-ar", str(SR), "-ac", "2", "-c:a", "pcm_s16le", str(final)],
        check=True,
    )

    loudness = measure_loudness(final)
    with wave.open(str(final), "rb") as stream:
        duration = stream.getnframes() / stream.getframerate()
        final_samples = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    sample_peak = float(np.max(np.abs(final_samples)))
    if duration > 60:
        raise RuntimeError("Narration is %.2fs, over the 60s limit" % duration)
    if sample_peak >= 0.999:
        raise RuntimeError("Narration clips (peak %.3f)" % sample_peak)

    narration = {
        "project": "dsh-waibao 0.1.3 update film",
        "language": "zh-CN",
        "voice": VOICE,
        "engine": "Windows System.Speech / SSML",
        "audio": "voiceover.wav",
        "format": "PCM s16le 48000 Hz stereo",
        "audio_start_offset_seconds": LEAD_IN,
        "duration_seconds": round(duration, 3),
        "loudness": {
            "integrated_lufs": loudness["integrated_lufs"],
            "loudness_range_lu": loudness["loudness_range_lu"],
            "true_peak_dbfs": loudness["true_peak_dbfs"],
            "sample_peak_dbfs": round(20 * math.log10(sample_peak), 2),
            "clipping": False,
        },
        "subtitles": cues,
    }
    (HERE / "narration.json").write_text(json.dumps(narration, ensure_ascii=False, indent=2), encoding="utf-8")
    (HERE / "captions.srt").write_text(
        "\n\n".join("%d\n%s --> %s\n%s" % (c["index"], srt_time(c["start"]), srt_time(c["end"]), c["text"])
                    for c in cues) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "duration_seconds": narration["duration_seconds"],
        "loudness": narration["loudness"],
        "files": ["voiceover.wav", "narration.json", "captions.srt"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
