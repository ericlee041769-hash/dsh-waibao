"""Drawing primitives and the twelve shots of the 0.1.3 vertical film.

Design space is 1080x1920. Everything is drawn with Pillow; the renderer in
render.py adds the camera move, the persistent HUD and the subtitles.

Safe area used throughout: x in [80, 1000], y in [150, 1500] for content,
subtitles in [1540, 1652] so nothing sits closer than 260 px to the bottom edge.
"""
import math
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920

INK = (10, 12, 12)
PAPER = (245, 243, 236)
WHITE = (246, 246, 240)
LIME = (214, 255, 72)
ORANGE = (255, 117, 74)
RED = (255, 74, 58)
GREY = (147, 154, 149)
NIGHT = (24, 28, 26)
NIGHT2 = (33, 38, 35)
EDGE = (56, 62, 58)

PAL = {
    "dark": dict(bg=INK, fg=WHITE, dim=GREY, card=NIGHT, card2=NIGHT2, line=EDGE),
    "light": dict(bg=PAPER, fg=INK, dim=(104, 108, 104), card=(255, 255, 252),
                  card2=(236, 234, 226), line=(210, 208, 198)),
    "lime": dict(bg=LIME, fg=INK, dim=(88, 104, 34), card=(24, 28, 26),
                 card2=(238, 255, 168), line=(126, 152, 48)),
}

_FONT_PATH = {}
_FONT_CACHE = {}


def init_fonts(regular, bold, mono):
    _FONT_PATH["r"] = regular
    _FONT_PATH["b"] = bold or regular
    _FONT_PATH["m"] = mono or regular
    _FONT_CACHE.clear()


def font(size, weight="b"):
    key = (int(size), weight)
    got = _FONT_CACHE.get(key)
    if got is None:
        got = ImageFont.truetype(_FONT_PATH.get(weight) or _FONT_PATH["r"], int(size))
        _FONT_CACHE[key] = got
    return got


def mix(c1, c2, t):
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return (round(c1[0] + (c2[0] - c1[0]) * t),
            round(c1[1] + (c2[1] - c1[1]) * t),
            round(c1[2] + (c2[2] - c1[2]) * t))


def cl(x, a=0.0, b=1.0):
    return a if x < a else (b if x > b else x)


def seg(p, a, b):
    if b <= a:
        return 1.0 if p >= a else 0.0
    return cl((p - a) / (b - a))


def eo(p):
    return 1 - (1 - cl(p)) ** 3


def eio(p):
    p = cl(p)
    return p * p * (3 - 2 * p)


def tx(d, xy, s, size, fill, weight="b", anchor=None, maxw=None, spacing=0):
    f = font(size, weight)
    if maxw:
        while size > 12 and f.getlength(s) > maxw:
            size -= 2
            f = font(size, weight)
    d.text(xy, s, font=f, fill=fill, anchor=anchor, spacing=spacing)
    return f.getlength(s)


def wrap(s, size, maxw, weight="r"):
    f = font(size, weight)
    rows, cur = [], ""
    for ch in s:
        if f.getlength(cur + ch) <= maxw or not cur:
            cur += ch
        else:
            rows.append(cur)
            cur = ch
    if cur:
        rows.append(cur)
    return rows


def para(d, x, y, s, size, fill, weight="r", maxw=900, lh=None, anchor="la"):
    rows = wrap(s, size, maxw, weight)
    lh = lh or int(size * 1.45)
    for n, row in enumerate(rows):
        d.text((x, y + n * lh), row, font=font(size, weight), fill=fill, anchor=anchor)
    return y + len(rows) * lh


def plate(d, box, fill, r=24, outline=None, width=2):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def chip(d, edge, cy, s, size, fg, bg, pad=(22, 12), r=16, weight="b", align="left", outline=None):
    f = font(size, weight)
    tw = f.getlength(s)
    w = tw + pad[0] * 2
    h = size + pad[1] * 2
    x0 = edge if align == "left" else edge - w
    d.rounded_rectangle((x0, cy - h / 2, x0 + w, cy + h / 2), radius=r, fill=bg,
                        outline=outline, width=2 if outline else 0)
    d.text((x0 + w / 2, cy), s, font=f, fill=fg, anchor="mm")
    return w


def hbar(d, x0, y0, x1, y1, frac, fill, track, r=8):
    plate(d, (x0, y0, x1, y1), track, r)
    span = (x1 - x0) * cl(frac)
    if span > r:
        plate(d, (x0, y0, x0 + span, y1), fill, r)


def vbar(d, x0, y0, x1, y1, frac, fill, track, r=10):
    plate(d, (x0, y0, x1, y1), track, r)
    fh = (y1 - y0) * cl(frac)
    if fh > r:
        plate(d, (x0, y1 - fh, x1, y1), fill, r)


def avatar(d, cx, cy, rad, letter, tone, fill, ring=None):
    d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=fill,
              outline=ring or tone, width=max(2, rad // 12))
    d.text((cx, cy - rad * 0.04), letter, font=font(int(rad * 0.95)), fill=tone, anchor="mm")


def dots(d, cx, cy, t, tone, r=13, gap=44, alive=True):
    for n in range(3):
        off = 0.0
        if alive:
            off = math.sin(t * 7.0 - n * 1.1) * 9
        d.ellipse((cx + (n - 1) * gap - r, cy - r + off, cx + (n - 1) * gap + r, cy + r + off), fill=tone)


def sprocket(d, cx, cy, t, tone, r=26):
    for n in range(8):
        a = t * 2.2 + n * math.pi / 4
        rr = r if n != 5 else r * 0.55
        px, py = cx + math.cos(a) * rr, cy + math.sin(a) * rr
        d.ellipse((px - 6, py - 6, px + 6, py + 6), fill=tone)


def strike(d, x0, y0, x1, y1, frac, tone, w=9):
    f = cl(frac)
    if f <= 0:
        return
    d.line((x0, y0, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f), fill=tone, width=w)


def stamp(d, cx, cy, s, size, fg, bg, scale=1.0, r=18, pad=(30, 16)):
    f = font(int(size * scale), "b")
    tw = f.getlength(s)
    w = tw + pad[0] * 2 * scale
    h = size * scale + pad[1] * 2 * scale
    d.rounded_rectangle((cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), radius=r * scale, fill=bg)
    d.text((cx, cy), s, font=f, fill=fg, anchor="mm")


# ----------------------------------------------------------------- shot 1
def shot_wait(im, d, p, lt, dur, P):
    """Pain hook: the inbox that never answers. Paper background."""
    bg, fg, dim = P["bg"], P["fg"], P["dim"]
    up = round(40 * (1 - eo(seg(p, 0.02, 0.20))))
    tx(d, (80, 226 + up), "任务交给 AI", 104, fg, maxw=900)
    tx(d, (80, 356 + up), "人还在等回信", 104, ORANGE, maxw=900)

    card = P["card"]
    plate(d, (80, 552, 1000, 1148), card, 30, fg, 3)
    tx(d, (122, 588), "收件箱", 34, dim, "r")
    tx(d, (958, 592), "未读 0 · 等待 1", 30, dim, "r", anchor="ra")
    d.line((122, 648, 958, 648), fill=P["line"], width=2)

    alive = p < 0.74
    d.rounded_rectangle((122, 692, 700, 860), radius=26, fill=fg)
    dots(d, 190, 776, lt, bg if alive else mix(bg, fg, 0.35), alive=alive)
    tx(d, (272, 748), "对方正在处理" if alive else "已停止响应", 32,
       mix(bg, fg, 0.55), "r")

    waited = 2467 + lt * 44
    clock = "%02d:%02d" % (int(waited // 60), int(waited % 60))
    tx(d, (122, 908), clock, 132, fg, maxw=520)
    tx(d, (600, 962), "已等待", 36, dim, "r")

    stuck = 0.62 + 0.035 * math.sin(lt * 5.0) if alive else 0.62
    hbar(d, 122, 1064, 958, 1084, stuck, ORANGE, P["line"], 10)
    tx(d, (122, 1104), "卡在这里 · 永远 62%" if alive else "它不会自己回来", 27, dim, "r")

    sprocket(d, 878, 764, lt, ORANGE if alive else dim)
    n = int(cl(lt / (dur * 0.9)) * 5 + 0.999)
    for k in range(min(5, n)):
        chip(d, 122 + k * 172, 1236, "待回信", 27, fg, P["card2"], pad=(18, 10))
    tx(d, (958, 1236), "×%d" % min(5, n), 44, ORANGE, anchor="rm")
    return im


# ----------------------------------------------------------------- shot 2
def shot_squad(im, d, p, lt, dur, P):
    """The turn: three roles take their seats."""
    fg, dim = P["fg"], P["dim"]
    tx(d, (80, 232), "改成一支", 96, fg, maxw=900)
    tx(d, (80, 352), "能沟通的小队", 96, LIME, maxw=900)

    xs = (80, 400, 720)
    names = ("查资料", "写实现", "做检查")
    settled = 0
    for n, x in enumerate(xs):
        a = seg(p, 0.10 + n * 0.14, 0.24 + n * 0.14)
        y = 620 + round(150 * (1 - eo(a)))
        if a >= 0.999:
            settled += 1
        plate(d, (x, y, x + 280, y + 380), P["card"], 26, LIME if a > 0.5 else P["line"], 3)
        avatar(d, x + 140, y + 108, 62, chr(65 + n), LIME, P["card2"])
        tx(d, (x + 140, y + 208), names[n], 48, fg, anchor="ma")
        tx(d, (x + 140, y + 276),
           "已就位" if a >= 0.999 else "召唤中",
           27, LIME if a >= 0.999 else dim, "r", anchor="ma")
    if settled >= 2:
        y = 1046
        d.line((80, y, 1000, y), fill=mix(P["line"], LIME, seg(p, 0.55, 0.75)), width=4)
        tx(d, (80, y + 34), "一个父任务 · 三个子任务 · 可以对话", 34, dim, "r")
    chip(d, 80, 1160, "父线程 1", 30, fg, P["card2"])
    chip(d, 300, 1160, "子任务 3", 30, LIME, P["card2"])
    return im


# ----------------------------------------------------------------- shot 3
def shot_parallel(im, d, p, lt, dur, P):
    """Three lanes at once. Vertical lanes, bars already running."""
    fg, dim = P["fg"], P["dim"]
    tx(d, (80, 214), "三个任务", 84, fg, maxw=560)
    tx(d, (80, 306), "同时开工", 84, LIME, maxw=560)
    chip(d, 958, 250, "并发 ×3", 34, INK, LIME, align="right")

    xs = (80, 400, 720)
    names = ("查资料", "写实现", "做检查")
    rates = (1.30, 0.98, 0.66)
    steps = (("读取仓库", "定位文件", "开始改写"),
             ("拉取接口", "复现问题", "准备补丁"),
             ("跑集成测试", "比对输出", "等待结果"))
    y0, y1 = 452, 1268
    for n, x in enumerate(xs):
        on = seg(p, 0.02 + n * 0.06, 0.14 + n * 0.06)
        if on <= 0.02:
            continue
        plate(d, (x, y0, x + 280, y1), P["card"], 26,
              LIME if on >= 0.99 else P["line"], 3)
        avatar(d, x + 140, y0 + 74, 40, chr(65 + n), LIME, P["card2"])
        tx(d, (x + 140, y0 + 136), names[n], 34, fg, anchor="ma")
        pulse = 0.55 + 0.45 * math.sin(lt * 6 - n)
        d.ellipse((x + 44, y0 + 174, x + 58, y0 + 188), fill=mix(P["card2"], LIME, pulse))
        tx(d, (x + 70, y0 + 181), "运行中", 23, dim, "r", anchor="lm")
        prog = cl(p * rates[n])
        vbar(d, x + 88, y0 + 224, x + 192, y1 - 116, prog, LIME, P["card2"], 14)
        step = steps[n][min(2, int(prog * 3))]
        tx(d, (x + 140, y1 - 92), step, 22, dim, "r", anchor="ma")
        tx(d, (x + 140, y1 - 50), "%d%%" % round(prog * 100), 34,
           fg if prog < 0.999 else LIME, anchor="ma")
    return im


# ----------------------------------------------------------------- shot 4
def shot_report(im, d, p, lt, dur, P):
    """One message travels through a clear corridor from child to parent."""
    fg, dim = P["fg"], P["dim"]
    travel = eo(seg(p, 0.06, 0.80))
    received = p >= 0.80
    tx(d, (80, 186), "有发现，直接汇报", 82, fg, maxw=920)

    # Receiver, transit corridor and sender occupy separate non-overlapping bands.
    plate(d, (80, 360, 1000, 600), P["card"], 28,
          LIME if received else P["line"], 3)
    avatar(d, 174, 448, 48, "C", LIME, P["card2"])
    tx(d, (260, 394), "Codex", 48, fg)
    tx(d, (260, 474), "已收到子任务的发现" if received else "接收子任务的消息", 34, dim, "r")
    chip(d, 958, 548, "已收到" if received else "接收中", 28, INK, LIME,
         align="right", pad=(20, 10))

    # Draw the route first; the single solid message card covers it as it travels.
    for y in range(638, 1110, 30):
        d.line((540, y, 540, y + 12), fill=P["line"], width=4)
    d.polygon(((540, 620), (522, 646), (558, 646)), fill=LIME)
    y = round(926 - 282 * travel)
    plate(d, (140, y, 940, y + 180), P["card2"], 26, LIME, 3)
    tx(d, (180, y + 28), "上下游接口对不上", 44, fg, maxw=720)
    tx(d, (180, y + 102), "先汇报，其他工作继续", 34, LIME, "r", maxw=720)

    plate(d, (80, 1150, 1000, 1430), P["card"], 28, P["line"], 2)
    avatar(d, 174, 1236, 48, "A", LIME, P["card2"])
    tx(d, (260, 1184), "DSH · 查资料", 48, fg)
    tx(d, (260, 1264), "子任务继续执行", 34, fg, "r")
    pulse = 0.6 + 0.4 * math.sin(lt * 6)
    d.ellipse((124, 1364, 140, 1380), fill=mix(P["card2"], LIME, pulse))
    tx(d, (158, 1352), "有发现就汇报，无需等到结束", 30, dim, "r")
    return im


# ----------------------------------------------------------------- shot 5
def shot_reply(im, d, p, lt, dur, P):
    """A concrete direction returns to the same child while the others continue."""
    fg, dim = P["fg"], P["dim"]
    travel = eo(seg(p, 0.12, 0.74))
    received = p >= 0.74
    tx(d, (80, 186), "收到，按这个方向做", 82, fg, maxw=920)

    plate(d, (80, 360, 1000, 600), P["card"], 28, fg, 3)
    avatar(d, 174, 448, 48, "C", INK, LIME)
    tx(d, (260, 394), "Codex", 48, fg)
    tx(d, (260, 474), "根据发现，调整下一步", 34, dim, "r")
    chip(d, 958, 548, "已回复" if p > 0.18 else "正在回复", 28, INK, ORANGE,
         align="right", pad=(20, 10))

    for y in range(638, 1100, 30):
        d.line((540, y, 540, y + 12), fill=P["line"], width=4)
    d.polygon(((540, 1120), (522, 1094), (558, 1094)), fill=ORANGE)
    y = round(640 + 204 * travel)
    plate(d, (140, y, 940, y + 220), P["card"], 26, ORANGE, 3)
    tx(d, (180, y + 28), "先确认下游接口，", 46, fg, maxw=720)
    tx(d, (180, y + 100), "把差异整理给我。", 46, fg, maxw=720)
    tx(d, (180, y + 174), "回复给：查资料", 26, dim, "r")

    plate(d, (80, 1150, 1000, 1430), P["card"], 28,
          (82, 116, 0) if received else P["line"], 3)
    avatar(d, 174, 1236, 48, "A", INK, LIME)
    tx(d, (260, 1184), "DSH · 查资料", 48, fg)
    tx(d, (260, 1264), "收到，正在核对接口" if received else "继续执行，接收新方向", 34, fg, "r")
    chip(d, 122, 1372, "已调整方向" if received else "任务继续", 28, INK, LIME,
         pad=(20, 10))
    tx(d, (958, 1372), "另外两个任务照常继续", 28, dim, "r", anchor="rm")
    return im


# ----------------------------------------------------------------- shot 6
def shot_stop(im, d, p, lt, dur, P):
    """Stop exactly one lane; the other two keep going. Horizontal rows."""
    fg, dim = P["fg"], P["dim"]
    tx(d, (80, 184), "一个跑偏？", 78, ORANGE, maxw=560)
    tx(d, (80, 272), "单独停掉 · 其他继续", 66, LIME, maxw=900)

    stopped = p >= 0.34
    rows = (440, 660, 880)
    names = ("查资料", "写实现", "做检查")
    for n, y in enumerate(rows):
        dead = n == 1 and stopped
        tone = RED if dead else LIME
        plate(d, (80, y, 1000, y + 176), P["card"] if not dead else mix(P["card"], INK, 0.4),
              24, ORANGE if (n == 1 and p >= 0.28) else P["line"], 3)
        avatar(d, 150, y + 88, 46, chr(65 + n), tone if not dead else dim, P["card2"])
        tx(d, (222, y + 40), names[n], 40, fg if not dead else dim, maxw=380)
        status = "已停止" if dead else ("完成" if p > 0.78 else "进行中")
        tx(d, (222, y + 112), status, 26, tone if not dead else dim, "r")
        frac = 0.42 if dead else cl(p * (1.12 if n == 0 else 0.86))
        hbar(d, 222, y + 132, 940, y + 152, frac, tone if not dead else dim, P["card2"], 10)
        tx(d, (958, y + 96), "%d%%" % round(frac * 100), 28, dim, "r", anchor="ra")
        if dead:
            stamp(d, 700, y + 78, "■ 已停止", 44, INK, ORANGE,
                  scale=1.0 + 0.5 * (1 - eo(seg(p, 0.34, 0.44))))

    if p > 0.8:
        chip(d, 80, 1152, "A 完成", 30, INK, LIME)
        chip(d, 268, 1152, "C 完成", 30, INK, LIME)
        chip(d, 456, 1152, "B 已停止", 30, INK, ORANGE)
    else:
        tx(d, (80, 1140), "停一个，不等于全停", 32, dim, "r")
    return im


# ----------------------------------------------------------------- shot 7
def shot_models(im, d, p, lt, dur, P):
    """Any configured provider/model; no allow-list. Light layout."""
    fg, dim = P["fg"], P["dim"]
    tx(d, (80, 212), "模型随你接", 94, fg, maxw=900)
    tx(d, (80, 330), "插件不设名单", 94, ORANGE, maxw=900)

    locks = (seg(p, 0.34, 0.44), seg(p, 0.44, 0.54), seg(p, 0.54, 0.64))
    final = ("任意已配置 provider", "任意已配置 model", "由 DSH 实际校验")
    for n, y in enumerate((600, 760, 920)):
        plate(d, (80, y - 62, 1000, y + 62), P["card"], 24, P["line"], 2)
        lk = locks[n]
        if lk < 0.99:
            spin = ("provider · ?", "model · ?", "选择中 · ?")
            k = int(lt * 22 + n) % 3
            tx(d, (122, y), spin[k], 40, dim, "r")
            tx(d, (958, y), "…", 40, dim, "r", anchor="rm")
        else:
            tx(d, (122, y), final[n], 40, fg, maxw=760)
            tx(d, (958, y), "已就绪", 28, LIME, "r", anchor="rm")

    kill = seg(p, 0.66, 0.80)
    if kill < 1.0:
        sh = 1 - eo(kill)
        cy = 1090
        plate(d, (200, cy - 62, 880, cy + 62), P["card2"], 22, dim, 2)
        tx(d, (540, cy), "固定模型名单", 44, dim, anchor="mm")
        strike(d, 210, cy + 6, 870, cy - 6, kill * 1.05, RED, 10)
    else:
        chip(d, 540, 1090, "名单已删除", 34, INK, LIME, align="right")

    tx(d, (80, 1210), "移除固定校验 · 接受 DSH 任意已配置 provider/model", 29, dim, "r")
    return im


# ----------------------------------------------------------------- shot 8
def shot_history(im, d, p, lt, dur, P):
    """Fast montage of 0.1.0 / 0.1.1 / 0.1.2 with jump cuts."""
    fg, dim = P["fg"], P["dim"]
    sub = min(2, int(p * 3))
    sp = cl(p * 3 - sub)
    pop = eo(seg(sp, 0.0, 0.10))

    tx(d, (80, 168), "历史版本", 32, dim, "r")
    for n in range(3):
        x = 320 + n * 54
        d.rounded_rectangle((x, 168, x + 42, 182), radius=7,
                            fill=LIME if n <= sub else P["card2"])
    tx(d, (958, 160), "0%d / 03" % (sub + 1), 30, dim, "m", anchor="ra")

    cards = (
        ("0.1.0", ("可见会话", "同会话续接", "完成回调"), "left"),
        ("0.1.1", ("单规格提交", "每轮证据", "跨进程互斥"), "right"),
        ("0.1.2", ("审批 / 问答分流", "运行中追加与停止"), "center"),
    )
    ver, items, mode = cards[sub]
    lift = round(50 * (1 - pop))

    rail_y = 1176
    trail = ("0.1.0", "0.1.1", "0.1.2", "0.1.3")
    for n, name in enumerate(trail):
        cx = 148 + n * 236
        active = n == sub
        ahead = n == 3
        d.rounded_rectangle((cx - 104, rail_y - 32, cx + 104, rail_y + 32), radius=16,
                            fill=LIME if active else (P["bg"] if ahead else P["card2"]),
                            outline=LIME if ahead else None, width=3)
        d.text((cx, rail_y), name, font=font(26),
               fill=INK if active else (LIME if ahead else dim), anchor="mm")
        if n < 3:
            d.line((cx + 112, rail_y, cx + 124, rail_y), fill=P["line"], width=3)

    if mode == "left":
        tx(d, (80, 430 + lift), ver, 156, LIME, maxw=430)
        tx(d, (80, 640 + lift), "把会话做成底座", 34, dim, "r")
        for n, s in enumerate(items):
            y = 424 + n * 190 + lift
            plate(d, (470, y, 1000, y + 140), P["card"], 22, P["line"], 2)
            tx(d, (506, y + 44), s, 42, fg, maxw=450)
    elif mode == "right":
        tx(d, (1000, 430 + lift), ver, 156, LIME, maxw=430, anchor="ra")
        tx(d, (1000, 640 + lift), "一次提交，两处隔离", 34, dim, "r", anchor="ra")
        for n, s in enumerate(items):
            y = 424 + n * 190 + lift
            plate(d, (80, y, 610, y + 140), P["card"], 22, P["line"], 2)
            tx(d, (116, y + 44), s, 42, fg, maxw=450)
    else:
        tx(d, (540, 392 + lift), ver, 176, LIME, anchor="ma")
        tx(d, (540, 622 + lift), "审批和问题各走各的路", 36, dim, "r", anchor="ma")
        for n, s in enumerate(items):
            y = 700 + n * 170 + lift
            plate(d, (80, y, 1000, y + 140), P["card"], 22, P["line"], 2)
            tx(d, (120, y + 44), s, 42, fg, maxw=820)
    return im


# ----------------------------------------------------------------- shot 9
def shot_hero(im, d, p, lt, dur, P):
    """0.1.3 impact card on a full lime field."""
    pop = eo(seg(p, 0.0, 0.26))
    size = round(240 * (1.55 - 0.55 * pop))
    d.text((540, 640), "0.1.3", font=font(size, "b"), fill=INK, anchor="mm")
    tx(d, (540, 800), "dsh-waibao", 58, INK, anchor="ma")

    a1 = seg(p, 0.36, 0.44)
    a2 = seg(p, 0.54, 0.62)
    if a1 > 0:
        stamp(d, 540, 980, "并行派工", 56, LIME, INK, scale=0.6 + 0.4 * eo(a1), pad=(46, 20))
    if a2 > 0:
        stamp(d, 540, 1110, "双向消息", 56, LIME, INK, scale=0.6 + 0.4 * eo(a2), pad=(46, 20))
    if a2 > 0.9:
        tx(d, (540, 1240), "这一次，父子任务终于接上话了", 34, INK, "r", anchor="ma")
    return im


# ----------------------------------------------------------------- shot 10
def shot_data(im, d, p, lt, dur, P):
    """Measured run: real counters and a message flow, labelled as re-typeset."""
    fg, dim = P["fg"], P["dim"]
    chip(d, 80, 186, "实测记录重排", 30, LIME, P["card2"], outline=LIME)
    tx(d, (80, 236), "2026-10-24 · DSH Desktop 0.2.1-rc.2", 27, dim, "r")
    tx(d, (80, 272), "aggregate / deepseek-v4-1-flash / high", 27, dim, "r")

    boxes = ((80, 336, 530, 616), (550, 336, 1000, 616),
             (80, 636, 530, 916), (550, 636, 1000, 916))
    stats = ((3, "任务并发", LIME), (6, "子→父 主动消息", LIME),
             (2, "父回复确认", ORANGE), (0, "投递 / 工具错误", LIME))
    for n, box in enumerate(boxes):
        value, label, tone = stats[n]
        plate(d, box, P["card"], 24, P["line"], 2)
        shown = round(value * eo(seg(p, 0.06 + n * 0.05, 0.42 + n * 0.05)))
        d.text(((box[0] + box[2]) / 2, box[1] + 112), str(shown),
               font=font(160, "b"), fill=tone if n != 3 else LIME, anchor="mm")
        tx(d, ((box[0] + box[2]) / 2, box[3] - 66), label, 33, fg, anchor="ma")

    d.rounded_rectangle((80, 972, 1000, 1052), radius=20, fill=P["card2"])
    tx(d, (116, 988), "父线程", 34, fg, maxw=300)
    tx(d, (958, 1012), "全部接通" if p > 0.7 else "接收中", 28,
       LIME if p > 0.7 else dim, "r", anchor="ra")

    for n in range(3):
        cx = 260 + n * 280
        d.ellipse((cx - 26, 1186, cx + 26, 1238), fill=P["card2"], outline=LIME, width=3)
        d.text((cx, 1212), chr(65 + n), font=font(30), fill=LIME, anchor="mm")
    for n in range(6):
        a = seg(p, 0.10 + n * 0.055, 0.34 + n * 0.055)
        if a <= 0 or a >= 1:
            continue
        src = 260 + (n // 2) * 280
        y = 1176 - 150 * eo(a)
        d.ellipse((src - 9, y - 9, src + 9, y + 9), fill=LIME)
        d.line((src, y + 12, src, 1150), fill=mix(P["card"], LIME, 0.5), width=3)
    for n in range(2):
        a = seg(p, 0.52 + n * 0.12, 0.70 + n * 0.12)
        if a <= 0 or a >= 1:
            continue
        dst = 260 + (n + 1) * 280
        y = 1062 + 118 * eo(a)
        d.ellipse((dst - 9, y - 9, dst + 9, y + 9), fill=ORANGE)

    tx(d, (80, 1290), "28 / 28 本地主机与 CLI 集成测试通过", 30, fg, maxw=900)
    tx(d, (80, 1336), "主机测试结论；真实模型验证单独表述", 26, dim, "r")
    return im


# ----------------------------------------------------------------- shot 11
def shot_mit(im, d, p, lt, dur, P):
    """Brand lockup and licence, on paper."""
    fg, dim = P["fg"], P["dim"]
    tx(d, (540, 430), "dsh-waibao", 92, fg, maxw=940, anchor="ma")
    tx(d, (540, 560), "0.1.3", 190, fg, anchor="ma")
    stamp(d, 540, 830, "MIT 开源", 60, LIME, INK,
          scale=0.55 + 0.45 * eo(seg(p, 0.30, 0.42)), pad=(52, 22))

    typed = eo(seg(p, 0.44, 0.80))
    repos = ("github.com/ericlee041769-hash/dsh-waibao",
             "gitee.com/sensenlee/dsh-waibao")
    for n, r in enumerate(repos):
        cut = int(len(r) * cl(typed * 2 - n))
        if cut > 0:
            tx(d, (540, 1010 + n * 62), r[:cut], 31, fg, "m", anchor="ma")
    if typed > 0.95:
        tx(d, (540, 1178), "两个仓库都在 · 装法与技能见 README", 30, dim, "r", anchor="ma")
    return im


# ----------------------------------------------------------------- shot 12
def shot_outro(im, d, p, lt, dur, P):
    """Closing couplet, then the call to action."""
    fg, dim = P["fg"], P["dim"]
    big = seg(p, 0.0, 0.34)
    cta = seg(p, 0.46, 0.60)

    if cta < 0.5:
        up = round(40 * (1 - eo(big)))
        tx(d, (540, 660 + up), "任务交得出去", 96, fg, maxw=940, anchor="ma")
        tx(d, (540, 800 + up), "过程也接得回来", 96, LIME, maxw=940, anchor="ma")
        sweep = eo(seg(p, 0.30, 0.52))
        if sweep > 0:
            d.rectangle((300, 930, 300 + 480 * sweep, 942), fill=LIME)
    else:
        tx(d, (540, 330), "任务交得出去", 64, fg, maxw=940, anchor="ma")
        tx(d, (540, 416), "过程也接得回来", 64, LIME, maxw=940, anchor="ma")
        plate(d, (80, 580, 1000, 1180), P["card"], 30, LIME, 3)
        tx(d, (540, 700), "dsh-waibao 0.1.3", 62, fg, maxw=880, anchor="ma")
        tx(d, (540, 800), "GitHub / Gitee 搜项目名", 44, dim, "r", anchor="ma")
        tx(d, (540, 880), "并行派工 · 双向消息 · 随便接模型", 36, LIME, "r", anchor="ma")
        chip(d, 540, 1010, "MIT 开源", 32, INK, LIME, align="right")
        tx(d, (540, 1100), "先看 README，再决定要不要用", 30, dim, "r", anchor="ma")
        if p > 0.86:
            d.ellipse((520, 1262, 560, 1302), fill=LIME)
    return im
