"""Render the dsh-waibao launch film from native DSH captures and code."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import wave

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / 'rendered')
parser.add_argument('--font', type=Path, default=Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/msyh.ttc')
parser.add_argument('--preview', action='store_true', help='Render poster and contact sheet only')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
W, H, FPS, DURATION = 1920, 1080, 24, 72
INK, MUTED, GREEN, BLUE = '#f1f6ff', '#98a9c1', '#78edc7', '#82b6ff'
FONT = {}
for size in [19, 21, 24, 26, 28, 30, 32, 36, 42, 46, 52, 58, 64, 72, 86, 116]:
    FONT[size] = ImageFont.truetype(str(args.font), size)
assets = {p.stem: Image.open(p).convert('RGB') for p in (ROOT / 'assets').glob('*.png')}
scenes = [
    (0, 7, 'Codex 负责拆解和把关，DSH 接手执行。', 'dsh-waibao · DSH 外包'),
    (7, 17, '不用猜进度：直接在 DSH 桌面查看执行过程。', '01 / 不用猜进度'),
    (17, 29, '不用反复交代背景：项目约定留在同一会话。', '02 / 少重复交代'),
    (29, 42, '真实续接：只问上轮内容，正确找回代号和交付约定。', '03 / 接着改，接着做'),
    (42, 52, '不用一直守着：完成通知回到 Codex，再继续验收。', '04 / 不用守着等'),
    (52, 63, '更适合多轮开发、长任务，以及 Codex 与 DSH 的分工。', '05 / 哪些时候有用'),
    (63, 72, '让委派看得见，让上下文接得上。', 'dsh-waibao · MIT 开源'),
]

# A generated gradient and restrained grid; every visual is local and reproducible.
yy, xx = np.mgrid[0:H, 0:W]
glow = np.exp(-(((xx - 1400) / 1150) ** 2 + ((yy - 250) / 650) ** 2))
base = np.stack([8 + glow * 8, 15 + glow * 14, 26 + glow * 20], axis=2).astype('uint8')
background = Image.fromarray(base)
bgdraw = ImageDraw.Draw(background)
for x in range(0, W, 80): bgdraw.line((x, 0, x, H), fill='#172331')
for y in range(0, H, 80): bgdraw.line((0, y, W, y), fill='#172331')
bgdraw.rectangle((0, 870, W, H), fill='#09111c')

def ease(v):
    v = max(0, min(1, v))
    return v * v * (3 - 2 * v)

def text(draw, xy, value, size, color=INK, anchor=None):
    draw.text(xy, value, font=FONT[size], fill=color, anchor=anchor, spacing=14)

def panel(draw, box, fill='#111e2d', outline='#2b3d50', radius=24):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=2)

def label(draw, x, y, value, color=GREEN):
    text(draw, (x, y), value, 24, color)

def image_panel(frame, image, box, crop=None):
    draw = ImageDraw.Draw(frame)
    x, y, width, height = box
    panel(draw, (x - 3, y - 3, x + width + 3, y + height + 3), '#121212', '#385062', 20)
    source = image.crop(crop) if crop else image
    scale = min(width / source.width, height / source.height)
    source = source.resize((round(source.width * scale), round(source.height * scale)), Image.Resampling.LANCZOS)
    frame.paste(source, (int(x + (width - source.width) / 2), int(y + (height - source.height) / 2)))

def frame_at(t):
    frame = background.copy()
    d = ImageDraw.Draw(frame)
    index = next((i for i, (a, b, _, _) in enumerate(scenes) if a <= t < b), 6)
    start, end, subtitle, chapter = scenes[index]
    local = t - start
    enter = ease(local / .65)
    slide = int((1 - enter) * 24)
    text(d, (80, 45), 'dsh-waibao', 30, GREEN)
    text(d, (1840, 53), 'DSH 外包  /  0.1.0', 21, MUTED, 'ra')
    d.line((80, 100, 1840, 100), fill='#2a3c50', width=2)

    if index == 0:
        label(d, 84, 177 + slide, 'CODEX → DSH DESKTOP')
        text(d, (80, 273 + slide), '把任务交出去', 86)
        text(d, (80, 413 + slide), '把过程接回来', 86, GREEN)
        text(d, (86, 612), '同一会话继续，完成后回来验收。', 36, MUTED)
        for n, (title, detail) in enumerate([('Codex', '分配任务'), ('DSH', '原生会话执行'), ('Codex', '收到完成 · 验收')]):
            x, y = 1120, 190 + n * 192
            panel(d, (x, y, x + 600, y + 140))
            text(d, (x + 36, y + 23), title, 42, GREEN if n == 1 else INK)
            text(d, (x + 255, y + 48), detail, 26, MUTED)
            if n < 2:
                d.line((1420, y + 142, 1420, y + 191), fill=GREEN, width=3)
                cy = y + 144 + int((t * 32) % 45)
                d.ellipse((1414, cy, 1426, cy + 12), fill=GREEN)
        text(d, (1420, 800), '工作流程示意', 19, MUTED, 'mm')
    elif index == 1:
        label(d, 80, 167, chapter)
        text(d, (80, 239 + slide), '任务在哪里？', 58)
        text(d, (80, 327 + slide), '就在桌面里。', 58, GREEN)
        text(d, (84, 440), '正在做什么', 32)
        text(d, (84, 497), '做到了哪一步', 32)
        text(d, (84, 554), '实际用了多少', 32)
        image_panel(frame, assets['round1'], (600, 155, 1240, 697))
        image_panel(frame, assets['sidebar'], (90, 681, 430, 120))
        d = ImageDraw.Draw(frame)
        text(d, (83, 829), '展开工作区，即可进入会话', 21, MUTED)
    elif index == 2:
        label(d, 80, 167, chapter)
        text(d, (80, 241 + slide), '记住一次，', 58)
        text(d, (80, 328 + slide), '接着做。', 58, GREEN)
        panel(d, (80, 469, 535, 678))
        label(d, 108, 494, '本次真实测试')
        text(d, (108, 549), '青竹-7316', 42)
        text(d, (108, 613), '每次说明验证结果', 26, MUTED)
        image_panel(frame, assets['round1'], (600, 164, 1240, 680), crop=(110, 65, 880, 375))
        d = ImageDraw.Draw(frame)
        text(d, (83, 760), '第一轮 · 提示与实际回答', 24, MUTED)
    elif index == 3:
        label(d, 80, 167, chapter)
        text(d, (80, 241 + slide), '再问一句，', 58)
        text(d, (80, 328 + slide), '上下文还在。', 58, GREEN)
        text(d, (84, 466), '新的请求', 32)
        text(d, (84, 525), '同一个 session', 32, BLUE)
        text(d, (84, 607), '不用重新粘贴历史正文', 26, MUTED)
        if local < 5:
            clip_index = min(4, int(local))
            shot = assets[f'live-{clip_index}']
            crop = None
        else:
            shot = assets['live-4']
            crop = (105, 328, 880, 616)
        image_panel(frame, shot, (600, 155, 1240, 697), crop=crop)
        d = ImageDraw.Draw(frame)
        text(d, (83, 760), '原生窗口采集 · 等待过程已剪辑', 21, MUTED)
    elif index == 4:
        label(d, 80, 167, chapter)
        text(d, (80, 241 + slide), '完成后，', 58)
        text(d, (80, 328 + slide), '主动回来。', 58, GREEN)
        text(d, (84, 474), '执行结束 → 完成事件', 30)
        text(d, (84, 539), 'Codex 检查实际产物', 30)
        text(d, (84, 604), '继续推进下一轮', 30)
        panel(d, (670, 184, 1770, 752))
        label(d, 711, 216, '实际回调记录 · 排版展示')
        d.line((711, 276, 1730, 276), fill='#304457', width=2)
        for i in range(2):
            y = 326 + i * 162
            d.ellipse((715, y + 5, 754, y + 44), fill=GREEN)
            text(d, (734, y + 21), '✓', 26, '#071c18', 'mm')
            text(d, (790, y), f'第 {i + 1} 轮  ·  已收到完成通知', 36)
            text(d, (790, y + 62), '退出码 0   /   status: notified', 26, MUTED)
        text(d, (712, 690), '验收以实际输出和测试为准', 26, BLUE)
    elif index == 5:
        label(d, 80, 167, chapter)
        text(d, (80, 244 + slide), '复杂任务，', 64)
        text(d, (80, 337 + slide), '分工推进。', 64, GREEN)
        text(d, (84, 504), '模型按你的选择执行', 30)
        text(d, (84, 567), '用实际结果验收', 30)
        text(d, (84, 660), '简单问答收益较小', 24, MUTED)
        text(d, (84, 711), '费用节省取决于任务与模型', 21, MUTED)
        rows = [('01', '多轮功能开发', '改完一轮，沿原上下文继续。'), ('02', '长时间测试与检查', '任务结束后回到原聊天，无需守候。'), ('03', '已有 DSH 模型与工具', '沿用现有配置，Codex 继续把关。')]
        for i, (num, title, detail) in enumerate(rows):
            y = 174 + i * 208
            panel(d, (670, y, 1780, y + 168))
            text(d, (706, y + 31), num, 46, GREEN)
            text(d, (812, y + 23), title, 36)
            text(d, (812, y + 95), detail, 24, MUTED)
    else:
        text(d, (960, 219 + slide), 'dsh-waibao', 116, GREEN, 'mm')
        text(d, (960, 362 + slide), '让委派看得见', 72, INK, 'mm')
        text(d, (960, 463 + slide), '让上下文接得上', 72, INK, 'mm')
        for i, value in enumerate(['桌面可见', '同会话续接', '完成回调']):
            x = 411 + i * 380
            panel(d, (x, 607, x + 338, 703), '#142c2b', '#345c55')
            text(d, (x + 169, 651), value, 32, GREEN, 'mm')
        text(d, (960, 770), '添加插件 → 安装 Codex 技能 → 发起委派', 28, MUTED, 'mm')
        text(d, (960, 831), 'Windows 首版  ·  MIT 许可  ·  视频源码一并提供', 21, MUTED, 'mm')

    # The permanent footage disclosure distinguishes native screenshots from graphics.
    d = ImageDraw.Draw(frame)
    text(d, (80, 916), '真实 DSH 桌面演示  /  剪辑与字幕由代码生成', 21, MUTED)
    text(d, (1840, 916), f'{index + 1:02d} / 07', 21, MUTED, 'ra')
    text(d, (960, 993), subtitle, 36, INK, 'mm')
    d.rectangle((80, 1051, 1840, 1055), fill='#243648')
    d.rectangle((80, 1051, 80 + int(1760 * t / DURATION), 1055), fill=GREEN)
    # Fade the whole scene through the same dark background on cuts.
    fade = min(ease(local / .3), ease((end - t) / .3))
    if fade < 1: frame = Image.blend(Image.new('RGB', (W, H), '#09111c'), frame, fade)
    return frame

def make_audio(destination):
    rate = 48000
    audio = np.zeros(int(DURATION * rate), dtype=np.float32)
    # Original procedural instrumental: a quiet pentatonic arpeggio and warm pad.
    harmony = [(146.83, 220, 293.66), (130.81, 196, 261.63), (164.81, 246.94, 329.63), (110, 164.81, 220)]
    for bar in range(24):
        start, length = bar * 3, 3
        tt = np.arange(int(length * rate), dtype=np.float32) / rate
        chord = harmony[bar % len(harmony)]
        envelope = np.minimum(tt / .3, 1) * np.minimum((length - tt) / .5, 1)
        segment = sum(np.sin(2 * np.pi * hz * tt) for hz in chord) * .021 * envelope
        audio[start * rate:(start + length) * rate] += segment
    for beat in range(DURATION * 2):
        start = beat / 2
        chord = harmony[int(start / 3) % 4]
        hz = chord[beat % 3] * 2
        tt = np.arange(rate, dtype=np.float32) / rate
        note = .055 * np.exp(-tt * 6) * np.minimum(tt / .008, 1) * (np.sin(2 * np.pi * hz * tt) + .2 * np.sin(4 * np.pi * hz * tt))
        offset = int(start * rate); count = min(len(note), len(audio) - offset)
        audio[offset:offset + count] += note[:count]
    tt = np.arange(len(audio)) / rate
    audio *= np.minimum(tt / 2, 1) * np.minimum((DURATION - tt) / 3, 1)
    stereo = np.stack((audio, audio * .95), axis=1)
    with wave.open(str(destination), 'wb') as out:
        out.setnchannels(2); out.setsampwidth(2); out.setframerate(rate)
        out.writeframes((np.clip(stereo, -1, 1) * 32767).astype('<i2').tobytes())

def stamp(seconds):
    return f'00:{int(seconds)//60:02d}:{int(seconds)%60:02d},000'

(args.output / 'dsh-waibao.srt').write_text('\n'.join(f'{i+1}\n{stamp(a)} --> {stamp(b)}\n{sub}\n' for i, (a, b, sub, _) in enumerate(scenes)), encoding='utf8')
frame_at(3.5).save(args.output / 'cover.png')
contact = Image.new('RGB', (1440, 1080), '#09111c')
for i, t in enumerate([3.5, 12, 23, 32, 39, 47, 58, 68]):
    image = frame_at(t).resize((480, 270), Image.Resampling.LANCZOS)
    contact.paste(image, ((i % 3) * 480, (i // 3) * 360))
    ImageDraw.Draw(contact).text(((i % 3) * 480 + 12, (i // 3) * 360 + 283), f'{t:g}s', fill=INK, font=FONT[24])
contact.save(args.output / 'contact-sheet.jpg', quality=94)
if args.preview:
    print('Preview rendered:', args.output)
    raise SystemExit(0)
make_audio(args.output / 'soundtrack.wav')
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
command = [ffmpeg, '-hide_banner', '-loglevel', 'warning', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', f'{W}x{H}', '-framerate', str(FPS), '-i', '-', '-i', str(args.output/'soundtrack.wav'), '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', str(args.output/'dsh-waibao-promo.mp4')]
with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
    for i in range(DURATION * FPS):
        encoder.stdin.write(frame_at(i / FPS).tobytes())
        if i % (FPS * 12) == 0: print(f'Rendered {i // FPS}/{DURATION}s', flush=True)
    encoder.stdin.close()
    if encoder.wait() != 0: raise RuntimeError('FFmpeg encode failed')
(args.output / 'manifest.json').write_text(json.dumps({'width': W, 'height': H, 'fps': FPS, 'seconds': DURATION, 'frames': DURATION * FPS, 'source': 'native DSH desktop captures plus procedural graphics and original music', 'disclosures': ['waiting time edited', 'callback receipts typeset from verified events', 'no promised cache savings']}, ensure_ascii=False, indent=2), encoding='utf8')
print('Rendered:', args.output/'dsh-waibao-promo.mp4')
