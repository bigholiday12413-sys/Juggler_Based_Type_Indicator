"""道具のドット絵（32×32）の下書きを生成する。

これは叩き台を作るための一度きりのスクリプト。生成後は public/img/tools/*.png を
ドット絵エディタで直接直す前提で、PNG が正となる（再実行すると手直しが上書きされる）。

色は2系統：道具ごとのモチーフカラー（ハイライト・基本）と、彩度を落とした影・輪郭。
使い方: python3 scripts/draw_sprites.py [プレビュー画像の出力先]
"""

import colorsys
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

N = 32
OUT = Path(__file__).resolve().parent.parent / "public" / "img" / "tools"


# ---- 色 ----
def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360, max(0, min(1, l / 100)), max(0, min(1, s / 100)))
    return (round(r * 255), round(g * 255), round(b * 255), 255)


def ramp(h, s, l):
    """モチーフカラー（hl, base）と、彩度を落とした影・輪郭（sh, ol）"""
    return {
        "hl": hsl(h, s, l + 14),
        "base": hsl(h, s, l),
        "sh": hsl(h, s * 0.45, l - 16),
        "ol": hsl(h, s * 0.35, max(10, l - 40)),
    }


# ---- 形（ピクセル中心が内側かどうか） ----
def pixels(test):
    return {(x, y) for y in range(N) for x in range(N) if test(x + 0.5, y + 0.5)}


def circle(cx, cy, r):
    return pixels(lambda x, y: (x - cx) ** 2 + (y - cy) ** 2 <= r * r)


def ellipse(cx, cy, rx, ry):
    return pixels(lambda x, y: ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1)


def ellipse_ring(cx, cy, rx, ry, width):
    def test(x, y):
        d = math.hypot((x - cx) / rx, (y - cy) / ry)
        return 1 - width / min(rx, ry) < d <= 1
    return pixels(test)


def arc_band(cx, cy, r, width, a0, a1):
    """中心角 a0〜a1（度、画面座標で時計回り）の円弧の帯"""
    def test(x, y):
        d = math.hypot(x - cx, y - cy)
        if not (r - width / 2 <= d <= r + width / 2):
            return False
        a = math.degrees(math.atan2(y - cy, x - cx))
        a = (a - a0) % 360
        return a <= (a1 - a0) % 360
    return pixels(test)


def seg_t(x, y, x0, y0, x1, y1):
    dx, dy = x1 - x0, y1 - y0
    t = ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return t, math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))


def profile(x0, y0, x1, y1, radius):
    """線分に沿って太さ radius(t) が変わる形（クラブ・スティックなど）"""
    return pixels(lambda x, y: (lambda t, d: d <= radius(t))(*seg_t(x, y, x0, y0, x1, y1)))


def capsule(x0, y0, x1, y1, r):
    return profile(x0, y0, x1, y1, lambda t: r)


def poly(points):
    def test(x, y):
        inside = False
        for i in range(len(points)):
            (xa, ya), (xb, yb) = points[i], points[i - 1]
            if (ya > y) != (yb > y) and x < (xb - xa) * (y - ya) / (yb - ya) + xa:
                inside = not inside
        return inside
    return pixels(test)


def rect(x0, y0, x1, y1):
    return pixels(lambda x, y: x0 <= x <= x1 and y0 <= y <= y1)


def line(points):
    """1px の線（ひも・ロープ用）"""
    out = set()
    for (xa, ya), (xb, yb) in zip(points, points[1:]):
        steps = int(max(abs(xb - xa), abs(yb - ya)) * 2) + 1
        for i in range(steps + 1):
            t = i / steps
            out.add((int(xa + (xb - xa) * t), int(ya + (yb - ya) * t)))
    return {(x, y) for x, y in out if 0 <= x < N and 0 <= y < N}


# ---- 塗り ----
def edge_shade(mask):
    """左上の縁をハイライト、右下の縁を影にする（筒・板もの向け）"""
    def shade(x, y):
        if (x - 1, y) not in mask or (x, y - 1) not in mask:
            return "hl"
        if (x + 1, y) not in mask or (x, y + 1) not in mask:
            return "sh"
        return "base"
    return shade


def sphere_shade(cx, cy, r):
    """左上から光が当たる球"""
    def shade(x, y):
        px, py = x + 0.5 - cx, y + 0.5 - cy
        if (px + 0.38 * r) ** 2 + (py + 0.38 * r) ** 2 <= (0.3 * r) ** 2:
            return "hl"
        if (px + py) / (r * math.sqrt(2)) > 0.45:
            return "sh"
        return "base"
    return shade


class Sprite:
    def __init__(self):
        self.px = {}

    def layer(self, mask, colors, shade=None, outline=True, tone=None):
        """outline: 形の外側1pxを輪郭色で塗ってから中を塗る（重なった物の境目にもなる）"""
        if outline:
            for x, y in mask:
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if (nx, ny) not in mask and 0 <= nx < N and 0 <= ny < N:
                        self.px[(nx, ny)] = colors["ol"]
        shade = shade or edge_shade(mask)
        for p in mask:
            key = tone(*p) if tone else None
            self.px[p] = colors[key or shade(*p)]
        return self

    def paint(self, mask, color):
        for p in mask:
            self.px[p] = color
        return self

    def image(self):
        img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
        for (x, y), c in self.px.items():
            if 0 <= x < N and 0 <= y < N:
                img.putpixel((x, y), c)
        return img


# ---- 道具ごとの絵 ----
GRAY = ramp(30, 12, 42)        # 持ち手の棒など、道具の色を邪魔しない無彩色寄り
STRING = hsl(35, 12, 60)       # ひも


def diabolo():
    c = ramp(355, 70, 48)
    s = Sprite()
    s.paint(line([(5, 20), (16, 14), (27, 20)]), STRING)
    s.layer(capsule(4.5, 20.5, 8.5, 30, 0.9), GRAY)
    s.layer(capsule(27.5, 20.5, 23.5, 30, 0.9), GRAY)
    body = poly([(6, 6), (15, 10.5), (15, 13.5), (6, 18)]) | poly([(26, 6), (17, 10.5), (17, 13.5), (26, 18)]) | rect(14.5, 10.5, 17.5, 13.5)
    s.layer(body, c)
    s.layer(ellipse(6.5, 12, 1.4, 6), c, tone=lambda x, y: "sh")
    s.layer(ellipse(25.5, 12, 1.4, 6), c, tone=lambda x, y: "sh")
    return s


def ball():
    c = ramp(26, 75, 55)
    s = Sprite()
    for cx, cy in ((8.5, 22.5), (23.5, 22.5), (16, 9.5)):
        s.layer(circle(cx, cy, 6.2), c, sphere_shade(cx, cy, 6.2))
    return s


def ring():
    c = ramp(325, 65, 55)
    s = Sprite()
    for cx, cy in ((8.5, 22.5), (23.5, 22.5), (16, 9.5)):
        s.layer(ellipse_ring(cx, cy, 7.4, 7.4, 2.4), c)
    return s


def club_radius(t):
    if t < 0.06:
        return 1.7
    if t < 0.42:
        return 1.0
    if t < 0.8:
        return 1.0 + 2.6 * math.sin((t - 0.42) / 0.38 * math.pi / 2)
    return 3.6 - 1.2 * (t - 0.8) / 0.2


def club():
    c = ramp(215, 60, 52)
    s = Sprite()
    for x0, y0, x1, y1 in ((4.5, 28.5, 25, 6), (27.5, 28.5, 7, 6)):
        mask = profile(x0, y0, x1, y1, club_radius)
        stripe = lambda x, y, a=(x0, y0, x1, y1): "hl" if 0.5 < seg_t(x + 0.5, y + 0.5, *a)[0] < 0.56 else None
        s.layer(mask, c, tone=stripe)
    return s


def devilstick():
    c = ramp(255, 45, 45)
    s = Sprite()
    s.layer(capsule(1.5, 25.5, 8.5, 18.5, 0.8), GRAY)
    s.layer(capsule(30.5, 6.5, 23.5, 13.5, 0.8), GRAY)
    a = (6, 3.5, 26, 28.5)
    mask = profile(*a, lambda t: 1.3 + 1.1 * abs(t - 0.5) * 2)
    tape = lambda x, y: "hl" if int(seg_t(x + 0.5, y + 0.5, *a)[0] * 9) % 2 == 0 and (x + y) % 2 == 0 else None
    s.layer(mask, c, tone=tape)
    return s


def flowerstick():
    c = ramp(46, 80, 55)
    fringe = ramp(15, 70, 55)
    s = Sprite()
    s.layer(capsule(1.5, 23.5, 8, 17, 0.8), GRAY)
    s.layer(capsule(30.5, 8.5, 24, 15, 0.8), GRAY)
    for ex, ey, dx, dy in ((10, 10, -1, -1), (22, 22, 1, 1)):
        d = 1 / math.sqrt(2)
        tip = (ex + dx * d * 8, ey + dy * d * 8)
        nx, ny = d * 4.5, -d * 4.5
        fan = poly([(ex, ey), (tip[0] + nx, tip[1] + ny), (tip[0] - nx, tip[1] - ny)])
        s.layer(fan, fringe, tone=lambda x, y: "hl" if (x - y) % 3 == 0 else "base")
    s.layer(capsule(10, 10, 22, 22, 1.4), c)
    return s


def cigarbox():
    c = ramp(140, 40, 45)
    label = hsl(45, 55, 75)
    s = Sprite()
    for x0, y0 in ((2, 13), (12, 9), (22, 13)):
        x1, y1 = x0 + 7, y0 + 13
        front = rect(x0, y0, x1, y1)
        top = poly([(x0, y0), (x0 + 2, y0 - 2), (x1 + 2, y0 - 2), (x1, y0)])
        side = poly([(x1, y0), (x1 + 2, y0 - 2), (x1 + 2, y1 - 2), (x1, y1)])
        region = lambda x, y, f=front, t=top: "base" if (x, y) in f else ("hl" if (x, y) in t else "sh")
        s.layer(front | top | side, c, tone=region)
        s.paint(rect(x0 + 0.5, y0 + 5, x1 - 0.5, y0 + 8), label)
    return s


def eightring():
    c = {"hl": (255, 255, 255, 255), "base": hsl(45, 20, 90), "sh": hsl(220, 10, 72), "ol": hsl(220, 12, 38)}
    grip = ramp(220, 12, 55)
    s = Sprite()
    s.layer(ellipse_ring(16, 16, 13.5, 13.5, 2.2), c)
    s.layer(arc_band(16, 16, 12.4, 2.4, 60, 120), grip)
    return s


def magbaton():
    c = ramp(192, 65, 50)
    spark = hsl(192, 70, 80)
    s = Sprite()
    for x, y in ((6, 6), (26, 25), (24, 5)):
        s.paint({(x, y - 1), (x - 1, y), (x, y), (x + 1, y), (x, y + 1)}, spark)
    s.layer(capsule(5, 27, 27, 5, 1.2), c)
    for cx, cy in ((5, 27), (27, 5)):
        s.layer(circle(cx, cy, 2.6), c, sphere_shade(cx, cy, 2.6))
    return s


def poi():
    c = ramp(285, 50, 52)
    trail = hsl(285, 35, 80)
    s = Sprite()
    s.paint(set(list(arc_band(16, 16, 13.5, 1, 100, 250))[::2]), trail)
    for hx, hy, bx, by in ((11, 3, 7, 23), (21, 3, 25, 20)):
        s.paint(line([(hx, hy + 2), (bx, by - 3)]), STRING)
        s.layer(ellipse_ring(hx, hy + 0.5, 2.2, 2.2, 1.2), GRAY)
        s.layer(circle(bx, by, 5), c, sphere_shade(bx, by, 5))
    return s


def contactball():
    c = {"hl": (255, 255, 255, 255), "base": hsl(195, 60, 88), "sh": hsl(205, 25, 72), "ol": hsl(210, 25, 40)}
    s = Sprite()
    s.layer(circle(16, 15.5, 11.5), c, sphere_shade(16, 15.5, 11.5))
    s.paint(arc_band(16, 15.5, 8.5, 1, 20, 70), c["hl"])
    s.paint(rect(8, 9, 9, 11), c["hl"])
    return s


def staff():
    c = ramp(25, 40, 45)
    wick = ramp(30, 8, 30)
    band = hsl(5, 45, 45)
    s = Sprite()
    a = (5, 27, 27, 5)
    s.layer(capsule(*a, 1.1), c, tone=lambda x, y: "hl" if 0.42 < seg_t(x + 0.5, y + 0.5, *a)[0] < 0.58 and (x + y) % 3 == 0 else None)
    s.paint({p for p in capsule(*a, 1.1) if 0.44 < seg_t(p[0] + 0.5, p[1] + 0.5, *a)[0] < 0.47 or 0.53 < seg_t(p[0] + 0.5, p[1] + 0.5, *a)[0] < 0.56}, band)
    for cx, cy in ((5, 27), (27, 5)):
        s.layer(circle(cx, cy, 3.6), wick, sphere_shade(cx, cy, 3.6))
    return s


def shakercup():
    c = ramp(165, 45, 55)
    s = Sprite()
    cups = (
        [(10, 30), (22, 30), (24, 21), (8, 21)],   # 下：上向き
        [(8, 20), (24, 20), (22, 12), (10, 12)],   # 中：下向き（口を合わせる）
        [(10, 11), (22, 11), (24, 2), (8, 2)],     # 上：上向き
    )
    for pts in cups:
        s.layer(poly(pts), c)
    s.paint(rect(8, 20.5, 23.5, 20.5) | rect(8, 2, 23.5, 2.5), c["hl"])
    return s


def flowwand():
    c = ramp(265, 40, 62)
    trail = hsl(265, 45, 85)
    s = Sprite()
    s.paint(arc_band(30, 30, 18, 1, 190, 250), trail)
    s.paint(arc_band(2, 2, 18, 1, 10, 70), trail)
    s.layer(capsule(7, 25, 25, 7, 0.8), c)
    for cx, cy in ((7, 25), (25, 7)):
        s.layer(circle(cx, cy, 1.8), c, sphere_shade(cx, cy, 1.8))
    return s


def dapocto():
    # 形が未確認のため仮置き（「？」）
    c = ramp(0, 0, 70)
    s = Sprite()
    s.layer(circle(16, 16, 12), c, sphere_shade(16, 16, 12))
    q = line([(12, 12), (13, 10), (16, 9), (19, 10), (20, 12), (19, 14), (16, 16), (16, 19)]) | rect(15.5, 22, 16.5, 23)
    s.paint(q, c["ol"])
    return s


def trickrope():
    c = ramp(38, 45, 68)
    s = Sprite()
    s.layer(ellipse_ring(16, 10, 13.5, 6, 1.4), c)
    s.layer(ellipse(16, 15.6, 1.6, 1.2), c, tone=lambda x, y: "sh")
    s.layer(profile(16, 16.5, 17, 30.5, lambda t: 0.7), c)
    return s


def buugeng():
    c = ramp(178, 40, 38)
    s = Sprite()
    s.layer(arc_band(16, 9.5, 6.3, 2.2, 95, 330) | arc_band(16, 22.5, 6.3, 2.2, 270, 135), c)
    return s


def kendama():
    wood = ramp(32, 45, 62)
    tama = ramp(95, 55, 48)
    s = Sprite()
    s.layer(capsule(16, 18, 16, 27, 1.8), wood)
    s.layer(poly([(12.5, 31.5), (19.5, 31.5), (18, 27), (14, 27)]), wood)
    s.layer(rect(9, 15.5, 22.5, 18.5), wood)
    s.layer(poly([(3.5, 12.5), (12.5, 12.5), (10.5, 18.5), (5.5, 18.5)]), wood)
    s.layer(poly([(20.5, 13.5), (28.5, 13.5), (27, 18.5), (22, 18.5)]), wood)
    s.layer(circle(16, 7.5, 6.2), tama, sphere_shade(16, 7.5, 6.2))
    return s


def hat():
    black = {"hl": hsl(240, 6, 34), "base": hsl(240, 6, 18), "sh": hsl(240, 4, 11), "ol": hsl(240, 5, 6)}
    ribbon = ramp(350, 60, 42)
    s = Sprite()
    s.layer(ellipse(16, 24, 14.5, 4), black)
    s.layer(poly([(9, 23), (23, 23), (22, 4), (10, 4)]), black)
    s.layer(poly([(9.2, 19), (22.8, 19), (22.9, 22.5), (9.1, 22.5)]), ribbon, outline=False)
    return s


TOOLS = {
    "diabolo": diabolo, "ball": ball, "ring": ring, "club": club, "devilstick": devilstick,
    "flowerstick": flowerstick, "cigarbox": cigarbox, "eightring": eightring, "magbaton": magbaton,
    "poi": poi, "contactball": contactball, "staff": staff, "shakercup": shakercup,
    "flowwand": flowwand, "dapocto": dapocto, "trickrope": trickrope, "buugeng": buugeng,
    "kendama": kendama, "hat": hat,
}


def preview(images, names, path, scale=6, cols=5):
    font = ImageFont.truetype("/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", 14)
    cell = N * scale
    rows = math.ceil(len(images) / cols)
    sheet = Image.new("RGBA", (cols * (cell + 16) + 16, rows * (cell + 40) + 16), (250, 248, 244, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (img, name) in enumerate(zip(images, names)):
        x, y = 16 + (i % cols) * (cell + 16), 16 + (i // cols) * (cell + 40)
        draw.rectangle([x - 1, y - 1, x + cell, y + cell], outline=(220, 220, 220, 255))
        sheet.alpha_composite(img.resize((cell, cell), Image.NEAREST), (x, y))
        draw.text((x, y + cell + 6), name, fill=(60, 60, 60, 255), font=font)
    sheet.save(path)


def main():
    import json
    names = {t["id"]: t["name"] for t in json.loads((OUT.parent.parent / "data" / "tools.json").read_text("utf-8"))}
    OUT.mkdir(parents=True, exist_ok=True)
    images = []
    for tool_id, draw in TOOLS.items():
        img = draw().image()
        img.save(OUT / f"{tool_id}.png")
        images.append(img)
    if len(sys.argv) > 1:
        preview(images, [names[t] for t in TOOLS], sys.argv[1])


if __name__ == "__main__":
    main()
