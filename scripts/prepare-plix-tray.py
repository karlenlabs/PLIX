"""Prepare the neutral tray from the approved PLIX tile, retaining its artwork.

The RGBA atlas includes every integer Windows small-icon size from 16 to 64.
Runtime selects an exact prefiltered image, without image decoders or changes
to the existing Play/Pause renderer or Windows icon slot dimensions.
"""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("plix_icons", ROOT / "scripts/prepare-plix-icons.py")
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)
source = ROOT / "assets/branding/plix/approved-original.png"
assert icons.digest(source) == icons.SOURCE_SHA256
native, _ = icons.extract(Image.open(source))
target = ROOT / "src-tauri/icons/tray"
target.mkdir(exist_ok=True)
atlas = bytearray()
frames = []
for size in range(16, 65):
    image = icons.resize(native, size)
    rgba = np.asarray(image)
    assert all(rgba[y, x, 3] == 0 for x, y in ((0, 0), (size-1, 0), (0, size-1), (size-1, size-1)))
    data = image.tobytes()
    frames.append({"size": size, "offset": len(atlas), "bytes": len(data),
                   "rgba_sha256": hashlib.sha256(data).hexdigest()})
    atlas.extend(data)
    if size in (16, 20, 24, 32):
        image.save(target / f"neutral-{size}.png")
(target / "neutral-16-64.rgba").write_bytes(atlas)
(target / "neutral-atlas.json").write_text(json.dumps({
    "source_sha256": icons.SOURCE_SHA256, "format": "straight RGBA8, row-major",
    "min_size": 16, "max_size": 64, "frames": frames,
}, indent=2) + "\n", encoding="utf-8")
sheet = Image.new("RGB", (620, 580), "#e8e9ec")
draw = ImageDraw.Draw(sheet)
draw.text((16, 12), "PLIX neutral tray / approved P / actual size + nearest zoom", fill="#222222")
for row, background in enumerate(("#ffffff", "#17191f")):
    top = 42 + row * 265
    draw.rectangle((10, top, 610, top + 252), fill=background)
    for index, size in enumerate((16, 20, 24, 32)):
        x = 28 + index * 145
        image = Image.open(target / f"neutral-{size}.png")
        draw.text((x, top + 10), f"{size}px", fill="#222222" if row == 0 else "#eeeeee")
        sheet.paste(image, (x, top + 40), image)
        zoom = image.resize((size * 4, size * 4), Image.Resampling.NEAREST)
        sheet.paste(zoom, (x, top + 100), zoom)
sheet.save(ROOT / "assets/branding/plix/tray-preview-light-dark.png")
print(f"Prepared {len(frames)} exact-size RGBA frames, {len(atlas)} bytes; PNG 16/20/24/32")
