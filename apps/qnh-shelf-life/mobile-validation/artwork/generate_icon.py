"""Generate the repo-native warehouse mark and legacy Android launcher densities."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / 'app/src/main/res'
BG, MINT, WHITE, GOLD = '#0D5C49', '#B5E7D0', '#FFFFFF', '#F3C66D'
BOXES = [(43, 30, 65, 51, MINT), (30, 55, 52, 76, WHITE), (56, 55, 78, 76, GOLD)]
BARS = [(60, 61, 62, 71), (64, 61, 65, 71), (67, 61, 70, 71), (72, 61, 74, 71)]

def rect_path(x, y, right, bottom, r=0):
    if not r: return f'M{x},{y}H{right}V{bottom}H{x}Z'
    return f'M{x+r},{y}H{right-r}Q{right},{y} {right},{y+r}V{bottom-r}Q{right},{bottom} {right-r},{bottom}H{x+r}Q{x},{bottom} {x},{bottom-r}V{y+r}Q{x},{y} {x+r},{y}Z'

shapes = [(rect_path(*b[:4], 4), b[4]) for b in BOXES]
shapes += [(rect_path(52, 30, 56, 38), BG), (rect_path(39, 55, 43, 63), BG)]
shapes += [(rect_path(*b), BG) for b in BARS]
shapes += [(rect_path(36, 79, 72, 82, 1.5), MINT)]
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108"><rect width="108" height="108" rx="25" fill="'+BG+'"/>'
svg += ''.join(f'<path fill="{color}" d="{path}"/>' for path, color in shapes) + '</svg>\n'
(ROOT/'artwork/kuguan-icon.svg').write_text(svg, encoding='utf-8')
header = '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n'
(RES/'drawable/ic_launcher_foreground.xml').write_text(header+''.join(f'    <path android:fillColor="{color}" android:pathData="{path}" />\n' for path,color in shapes)+'</vector>\n', encoding='utf-8')
(RES/'drawable/ic_launcher_monochrome.xml').write_text(header+'    <path android:fillColor="#FFFFFF" android:fillType="evenOdd" android:pathData="'+''.join(p for p,c in shapes)+'" />\n</vector>\n', encoding='utf-8')
(RES/'values/launcher_colors.xml').write_text(f'<resources><color name="launcher_background">{BG}</color></resources>\n', encoding='utf-8')

def image(size, circle=False):
    scale = 12
    im = Image.new('RGBA', (108*scale, 108*scale))
    d = ImageDraw.Draw(im)
    def rect(bounds, fill, radius=0):
        xy = tuple(round(v*scale) for v in bounds)
        d.rounded_rectangle(xy, radius=round(radius*scale), fill=fill)
    if circle: d.ellipse((0,0,108*scale-1,108*scale-1),fill=BG)
    else: rect((0,0,108,108), BG, 25)
    for *bounds,color in BOXES: rect(bounds,color,4)
    for bounds in [(52,30,56,38),(39,55,43,63),*BARS]: rect(bounds,BG)
    rect((36,79,72,82),MINT,1.5)
    return im.resize((size,size),Image.Resampling.LANCZOS)

for density,size in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
    for round_icon in [False,True]: image(size,round_icon).save(RES/f'mipmap-{density}'/('ic_launcher_round.png' if round_icon else 'ic_launcher.png'))
image(512).save(ROOT/'artwork/kuguan-icon.png')
