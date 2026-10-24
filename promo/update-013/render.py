#!/usr/bin/env python3
"""dsh-waibao 0.1.3 — 44.69 s vertical promo film.

Frames are drawn with Pillow and encoded with a local FFmpeg. No third-party
footage, no stock music: the beat bed is synthesised here, mixed under the
narration. Everything resolves relative to this file.

    python render.py --preview          # one frame per shot + contact sheet
    python render.py                    # full film into ../outputs/update-013
    python render.py --times 3.0,26.9   # specific frames, for layout checks

Paths are relative by default. Override with --audio-dir, --out, --frames-dir,
--font, --font-bold, --font-mono, --ffmpeg.
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import shots as S
from shots import W, H, LIME, ORANGE, INK, PAPER, WHITE, GREY, mix

HERE = Path(__file__).resolve().parent
DEFAULT_AUDIO = HERE / "audio"
DEFAULT_OUT = HERE.parent.parent / "outputs" / "update-013"
FPS = 30
TAIL = 1.5

SHOT_FUNCS = (S.shot_wait, S.shot_squad, S.shot_parallel, S.shot_report,
              S.shot_reply, S.shot_stop, S.shot_models, S.shot_history,
              S.shot_hero, S.shot_data, S.shot_mit, S.shot_outro)
SHOT_PAL = ("light", "dark", "dark", "dark", "light", "dark",
            "light", "dark", "lime", "dark", "light", "dark")
SHOT_TAG = ("工作流示意",) * 9 + ("实测记录重排", "MIT 开源", "MIT 开源")


def shot_bounds(cues, duration):
    starts = [float(c["start"]) for c in cues]
    return [(starts[i], starts[i + 1] if i + 1 < len(starts) else duration)
            for i in range(len(starts))]


def camera_for(i, p, lt):
    """(zoom, cx, cy) per shot; max zoom keeps 12% headroom so nothing clips."""
    if i == 0:
        return 1.0 + 0.06 * S.eio(p), 540, 900
    if i == 1:
        return 1.09 - 0.09 * S.eo(p), 540, 820
    if i == 2:
        z = 1.0 + 0.05 * S.eio(p)
        j = 0.0
        if lt < 0.16:
            j = 9 * (1 - lt / 0.16) * math.sin(lt * 90)
        return z, 540 + j, 860 + j * 0.5
    if i == 3:
        return 1.0 + 0.09 * S.eio(p), 540, 980 - 300 * S.eo(S.seg(p, 0.42, 0.80))
    if i == 4:
        return 1.04, 540, 520 + 330 * S.eo(S.seg(p, 0.05, 0.62))
    if i == 5:
        z = 1.0 + 0.03 * S.eio(p)
        j = 0.0
        if 0.30 <= p <= 0.44:
            j = 14 * (1 - (p - 0.30) / 0.14) * math.sin(p * 210)
        return z, 540, 860 + j
    if i == 6:
        return 1.02, 540, 700 + 200 * S.eio(S.seg(p, 0.1, 0.7))
    if i == 7:
        sub = min(2, int(p * 3))
        return (1.0, 540, 800) if sub == 0 else ((1.05, 500, 810) if sub == 1 else (1.0, 540, 770))
    if i == 8:
        return 1.12 - 0.12 * S.eo(S.seg(p, 0.0, 0.55)), 540, 760
    if i == 9:
        return 1.0 + 0.06 * S.eio(p), 540, 820
    if i == 10:
        return 1.0 + 0.06 * S.eio(p), 540, 800
    return 1.05 - 0.05 * S.eio(p), 540, 820


def apply_camera(im, zoom, cx, cy):
    if abs(zoom - 1.0) < 0.004 and abs(cx - 540) < 1 and abs(cy - 960) < 1:
        return im
    cw, ch = W / zoom, H / zoom
    x0 = min(max(cx - cw / 2, 0), W - cw)
    y0 = min(max(cy - ch / 2, 0), H - ch)
    return im.resize((W, H), Image.Resampling.BICUBIC,
                     box=(x0, y0, x0 + cw, y0 + ch))


def flash_at(i, p, lt):
    """Hard-cut accents: (alpha, colour) or None."""
    if i in (1, 5, 8, 10) and lt < 0.055:
        return 0.72 * (1 - lt / 0.055), (255, 255, 255) if i != 8 else INK
    if i == 5 and 0.335 <= p <= 0.395:
        return 0.55, (255, 255, 255)
    if i == 7:
        for cut in (0.333, 0.667):
            if cut <= p <= cut + 0.016:
                return 0.6, (255, 255, 255)
    if i == 3 and abs(p - 0.76) < 0.016:
        return 0.35, LIME
    if i == 10 and abs(p - 0.40) < 0.018:
        return 0.30, LIME
    return None


def draw_hud(im, t, duration, shot_i):
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, 8), fill=(46, 52, 48))
    d.rectangle((0, 0, W * min(1.0, t / duration), 8), fill=LIME)
    light = shot_i in (0, 4, 6, 8, 10)
    chip_bg = INK if light else (255, 255, 252)
    chip_fg = (255, 255, 252) if light else INK
    d.rounded_rectangle((80, 62, 372, 118), radius=15, fill=chip_bg)
    d.text((110, 90), "dsh-waibao 0.1.3", font=S.font(27), fill=chip_fg, anchor="lm")
    tag = SHOT_TAG[shot_i]
    tw = S.font(26, "r").getlength(tag)
    x0 = 1000 - tw - 44
    d.rounded_rectangle((x0, 62, 1000, 118), radius=15, fill=chip_bg)
    d.text(((x0 + 1000) / 2, 90), tag, font=S.font(26, "r"), fill=chip_fg, anchor="mm")
    return im


def draw_subtitle(im, text):
    if not text:
        return im
    d = ImageDraw.Draw(im)
    rows = S.wrap(text, 46, 872, "b")
    rows = rows[:2]
    h = len(rows) * 60 + 28
    y1 = 1652
    y0 = y1 - h
    d.rounded_rectangle((70, y0, 1010, y1), radius=20, fill=(9, 11, 11))
    for n, row in enumerate(rows):
        d.text((540, y0 + 16 + n * 60), row, font=S.font(46), fill=(246, 246, 240), anchor="ma")
    return im


def frame(t, cues, bounds, duration, pal):
    i = 0
    for k, (a, b) in enumerate(bounds):
        if t >= a:
            i = k
        else:
            break
    start, end = bounds[i]
    dur = max(1e-6, end - start)
    lt = max(0.0, t - start)
    p = S.cl(lt / dur)
    P = pal[SHOT_PAL[i]]

    im = Image.new("RGB", (W, H), P["bg"])
    d = ImageDraw.Draw(im)
    im = SHOT_FUNCS[i](im, d, p, lt, dur, P)

    zoom, cx, cy = camera_for(i, p, lt)
    im = apply_camera(im, zoom, cx, cy)

    fl = flash_at(i, p, lt)
    if fl:
        a, c = fl
        if a > 0.01:
            im = Image.blend(im, Image.new("RGB", (W, H), c), min(0.85, a))

    im = draw_hud(im, t, duration, i)
    sub = ""
    for c in cues:
        if float(c["start"]) - 0.02 <= t <= float(c["end"]) + 0.12:
            sub = c["text"]
            break
    im = draw_subtitle(im, sub)

    if t > duration - 0.55:
        k = 1 - 0.55 * S.cl((t - (duration - 0.55)) / 0.55)
        im = Image.eval(im, lambda v: int(v * k))
    return im


# --------------------------------------------------------------------- audio
def build_bed(duration, sr=48000, cues=()):
    n = int(round(duration * sr))
    t = np.arange(n) / sr
    rng = np.random.default_rng(7)
    bed = np.zeros(n)

    def add(at, sig, gain):
        s = int(round(at * sr))
        if s >= n:
            return
        e = min(n, s + len(sig))
        bed[s:e] += sig[: e - s] * gain

    def kick():
        tt = np.arange(int(0.30 * sr)) / sr
        f = 118 - 74 * (tt / 0.30)
        env = np.exp(-tt / 0.085)
        return np.sin(2 * np.pi * f * tt) * env

    def hat():
        tt = np.arange(int(0.05 * sr)) / sr
        noise = rng.normal(0, 1, len(tt))
        noise = np.diff(noise, prepend=0.0)
        return noise * np.exp(-tt / 0.013)

    def hit():
        tt = np.arange(int(0.75 * sr)) / sr
        low = np.sin(2 * np.pi * 52 * tt) * np.exp(-tt / 0.19)
        burst = rng.normal(0, 1, len(tt)) * np.exp(-tt / 0.05)
        return low * 0.9 + burst * 0.35

    ki, hi = kick(), hat()
    beat = 0.5
    k = 0
    while k * beat < duration:
        add(k * beat, ki, 0.50 if k % 2 == 0 else 0.34)
        add(k * beat + 0.25, hi, 0.16)
        k += 1

    for at, g in ((0.20, 0.55), (3.917, 0.85), (14.829, 0.9), (26.656, 1.0), (35.257, 0.8)):
        add(at, hit(), g)
    for at in (26.10, 34.72):
        tt = np.arange(int(0.55 * sr)) / sr
        riser = rng.normal(0, 1, len(tt)) * (tt / 0.55) ** 2
        add(at, riser, 0.30)

    drone = (np.sin(2 * np.pi * 55 * t) * 0.6 + np.sin(2 * np.pi * 82.4 * t) * 0.35)
    drone *= 0.55 + 0.45 * np.sin(2 * np.pi * 0.22 * t)
    bed += drone * 0.045

    peak = float(np.max(np.abs(bed))) or 1.0
    return bed / peak * 0.115


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise SystemExit("expected 16-bit PCM: %s" % path)
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch)
    else:
        a = a.reshape(-1, 1)
    return a, sr


def write_wav(path, data, sr):
    clipped = np.clip(data, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def mix_audio(voice_path, out_path, duration, cues):
    voice, sr = read_wav(voice_path)
    n = int(round(duration * sr))
    if len(voice) < n:
        voice = np.vstack([voice, np.zeros((n - len(voice), voice.shape[1]), dtype=np.float32)])
    voice = voice[:n]
    bed = build_bed(duration, sr, cues)
    mixed = voice.copy()
    voice_peak = float(np.max(np.abs(voice))) or 1.0
    room = max(0.0, 0.955 - voice_peak)
    gain = min(1.0, room / 0.115) if room > 0 else 0.0
    mixed += (bed * gain)[:, None]
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.985:
        mixed *= 0.985 / peak
    write_wav(out_path, mixed, sr)
    return dict(voice_peak=round(voice_peak, 4), bed_gain=round(gain, 4),
                mixed_peak=round(float(np.max(np.abs(mixed))), 4), sample_rate=sr)


# --------------------------------------------------------------------- output
def contact_sheet(frames, path, cols=4, tile=(270, 480)):
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (tile[0] * cols, tile[1] * rows), (26, 26, 26))
    for n, (im, _label) in enumerate(frames):
        sheet.paste(im.resize(tile, Image.Resampling.LANCZOS),
                    ((n % cols) * tile[0], (n // cols) * tile[1]))
    sheet.save(path, quality=93)
    return path


def encode(frames_dir, audio_path, out_path, ffmpeg, duration):
    log = out_path.with_suffix(".encode.log")
    cmd = [ffmpeg, "-y", "-v", "error",
           "-framerate", str(FPS), "-i", str(frames_dir / "%05d.png"),
           "-i", str(audio_path),
           "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
           "-t", "%.3f" % duration, "-movflags", "+faststart", str(out_path)]
    with open(log, "wb") as fh:
        rc = subprocess.call(cmd, stdout=fh, stderr=fh, stdin=subprocess.DEVNULL)
    if rc != 0:
        raise SystemExit("ffmpeg failed (%d): %s" % (rc, log))


def main():
    ap = argparse.ArgumentParser(description="dsh-waibao 0.1.3 vertical film")
    ap.add_argument("--audio-dir", type=Path, default=DEFAULT_AUDIO)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--frames-dir", type=Path, default=HERE / "out" / "frames")
    ap.add_argument("--font", default=str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"))
    ap.add_argument("--font-bold", default=None)
    ap.add_argument("--font-mono", default=None)
    ap.add_argument("--ffmpeg", default=None)
    ap.add_argument("--preview", action="store_true", help="one frame per shot + contact sheet")
    ap.add_argument("--times", default=None, help="comma separated seconds to dump")
    ap.add_argument("--keep-frames", action="store_true")
    ap.add_argument("--frames-only", action="store_true", help="dump frames, skip encoding")
    ap.add_argument("--encode-only", action="store_true", help="encode existing frames")
    args = ap.parse_args()

    nar = json.loads((args.audio_dir / "narration.json").read_text(encoding="utf-8-sig"))
    cues = nar["subtitles"]
    duration = float(nar["duration_seconds"]) + TAIL
    bounds = shot_bounds(cues, duration)

    win = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    bold = args.font_bold or (str(win / "msyhbd.ttc") if (win / "msyhbd.ttc").exists() else args.font)
    mono = args.font_mono or (str(win / "consolab.ttf") if (win / "consolab.ttf").exists() else bold)
    S.init_fonts(args.font, bold, mono)

    pal = {k: dict(v) for k, v in S.PAL.items()}
    pal["dark"] = dict(S.PAL["dark"])
    args.out.mkdir(parents=True, exist_ok=True)
    args.frames_dir.mkdir(parents=True, exist_ok=True)

    # A dedicated cover carries the hook without a frozen narration subtitle.
    cover = Image.new("RGB", (W, H), INK)
    cd = ImageDraw.Draw(cover)
    S.chip(cd, 80, 130, "DSH 外包 / 0.1.3", 34, INK, LIME)
    S.tx(cd, (80, 290), "我给 Codex", 112, WHITE, maxw=920)
    S.tx(cd, (80, 450), "接了一支", 112, WHITE, maxw=920)
    S.tx(cd, (80, 610), "能回话的 AI 小队", 100, LIME, maxw=920)
    for k, label in enumerate(("查资料", "写实现", "做检查")):
        cx = 230 + k * 310
        S.plate(cd, (cx - 140, 850, cx + 140, 1110), (24, 28, 26), 28, LIME, 3)
        S.avatar(cd, cx, 932, 42, chr(65 + k), LIME, INK)
        S.tx(cd, (cx, 1016), label, 42, WHITE, anchor="ma")
    S.plate(cd, (80, 1190, 790, 1310), PAPER, 24)
    S.tx(cd, (120, 1226), "子任务：发现冲突，我先汇报", 38, INK, maxw=630)
    S.plate(cd, (290, 1350, 1000, 1470), LIME, 24)
    S.tx(cd, (330, 1386), "父任务：收到，按新方案继续", 38, INK, maxw=630)
    S.tx(cd, (540, 1530), "并行开工 · 中途交流 · 单独叫停", 40, WHITE, anchor="ma")
    S.tx(cd, (540, 1620), "MIT 开源  /  dsh-waibao", 32, LIME, anchor="ma")
    cover.save(args.out / "cover.png")


    if args.times:
        picked = [float(x) for x in args.times.split(",") if x.strip()]
        for n, t in enumerate(picked):
            frame(t, cues, bounds, duration, pal).save(
                args.frames_dir / ("t%06.2f.png" % t))
        print(json.dumps({"wrote": len(picked), "dir": str(args.frames_dir)}, ensure_ascii=False))
        return

    if args.preview:
        picks = [round(a + (b - a) * f, 3) for (a, b), f in
                 zip(bounds, (0.60, 0.72, 0.62, 0.72, 0.60, 0.86,
                              0.80, 0.18, 0.80, 0.62, 0.80, 0.32))]
        frames = []
        for n, t in enumerate(picks):
            im = frame(t, cues, bounds, duration, pal)
            im.save(args.out / ("preview-%02d.jpg" % (n + 1)), quality=92)
            frames.append((im, t))
        contact_sheet(frames, args.out / "contact-sheet.jpg")
        print(json.dumps({"preview": str(args.out), "duration": duration,
                          "shots": len(bounds)}, ensure_ascii=False))
        return

    total = int(round(duration * FPS))
    if not args.encode_only:
        for n in range(total):
            frame(n / FPS, cues, bounds, duration, pal).save(
                args.frames_dir / ("%05d.png" % n), compress_level=1)
            if n % 120 == 0:
                print("frame %d/%d" % (n, total), flush=True)
        print("frames done: %d" % total, flush=True)
        if args.frames_only:
            return

    mixed = args.out / "mix.wav"
    info = mix_audio(args.audio_dir / "voiceover.wav", mixed, duration, cues)

    ffmpeg = args.ffmpeg
    if not ffmpeg:
        try:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("no ffmpeg: pass --ffmpeg or set one on PATH")

    video = args.out / "dsh-waibao-0.1.3-short.mp4"
    encode(args.frames_dir, mixed, video, ffmpeg, duration)

    src_srt = args.audio_dir / "captions.srt"
    if src_srt.exists():
        shutil.copyfile(src_srt, args.out / "captions.srt")
    contact_sheet([(frame((a + b) / 2 + (b - a) * 0.18, cues, bounds, duration, pal), t)
                   for (a, b), t in zip(bounds, range(len(bounds)))],
                  args.out / "contact-sheet.jpg")

    if not args.keep_frames:
        shutil.rmtree(args.frames_dir, ignore_errors=True)

    manifest = dict(width=W, height=H, fps=FPS, seconds=round(duration, 3),
                    frames=total, video=video.name, audio="AAC 192k 48k stereo",
                    voice=nar.get("voice"), mixed_audio=info,
                    disclosure=list(dict.fromkeys(SHOT_TAG)),
                    shots=[{"index": k + 1, "tag": SHOT_TAG[k],
                            "start": round(a, 3), "end": round(b, 3)}
                           for k, (a, b) in enumerate(bounds)])
    (args.out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"video": str(video), "seconds": duration, "frames": total,
                      "audio": info}, ensure_ascii=False))


if __name__ == "__main__":
    main()
