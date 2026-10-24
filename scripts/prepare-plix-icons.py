"""Deterministically extract the approved PLIX tile and package Windows icons.

Requires Pillow and NumPy. No generated artwork, recoloring, or shape replacement.
The source digest locks the contour extraction to the approved 1254px image.
"""
import argparse
import hashlib
import io
import json
import shutil
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "assets/branding/plix"
ICONS = ROOT / "src-tauri/icons"
SIZES = (16, 24, 32, 48, 64, 128, 256)
SOURCE_SHA256 = "6c0fdd77c7e5cc07154357a7b3d23eee903b3534ed0bd59d7d21efad841efb24"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(source):
    rgb = np.asarray(source.convert("RGB"), dtype=np.int16)
    assert source.size == (1254, 1254), "Extraction is specific to the approved image"
    # Locate the actual dark/saturated tile, excluding the neutral white backdrop
    # and its external drop shadow. Fill each scanline; never key out the P/Play.
    seed = (rgb.min(2) < 130) | ((rgb.max(2) - rgb.min(2)) > 60)
    seed[:80] = False
    seed[1157:] = False
    seed[:, :85] = False
    seed[:, 1170:] = False
    filled = np.zeros(seed.shape, dtype=np.uint8)
    for y in range(80, 1157):
        xs = np.flatnonzero(seed[y])
        if xs.size:
            filled[y, xs[0]:xs[-1] + 1] = 255
    shape = Image.fromarray(filled)
    core = np.asarray(shape.filter(ImageFilter.MinFilter(3))) == 255
    ring = (np.asarray(shape.filter(ImageFilter.MaxFilter(3))) > 0) & ~core
    result = np.dstack((rgb.astype(np.uint8), core.astype(np.uint8) * 255))
    # Recover the subpixel coverage only at the 1px boundary. Estimate nearby
    # foreground/background along the boundary normal and undo the old matte.
    # All core RGB pixels remain byte-identical to the approved source.
    offsets = sorted(((dx, dy) for dy in range(-4, 5) for dx in range(-4, 5)
                      if dx or dy), key=lambda p: p[0] ** 2 + p[1] ** 2)
    for y, x in np.argwhere(ring):
        dx, dy = next((dx, dy) for dx, dy in offsets if core[y + dy, x + dx])
        fg = rgb[y + dy, x + dx].astype(float)
        length = max(abs(dx), abs(dy))
        bx, by = round(x - 3 * dx / length), round(y - 3 * dy / length)
        bg = rgb[by, bx].astype(float)
        color = rgb[y, x].astype(float)
        direction = fg - bg
        alpha = float(np.clip(np.dot(color - bg, direction) /
                              max(1, np.dot(direction, direction)), 0, 1))
        if alpha > 0.01:
            unmatted = np.clip((color - (1 - alpha) * bg) / alpha, 0, 255)
            result[y, x, :3] = np.rint(unmatted).astype(np.uint8)
            result[y, x, 3] = round(alpha * 255)
    result[result[:, :, 3] == 0, :3] = 0
    cutout = Image.fromarray(result)
    bbox = cutout.getbbox()
    side = max(bbox[2] - bbox[0], bbox[3] - bbox[1]) + 16
    crop_x = (bbox[0] + bbox[2] - side) // 2
    crop_y = (bbox[1] + bbox[3] - side) // 2
    native = cutout.crop((crop_x, crop_y, crop_x + side, crop_y + side))
    assert np.array_equal(result[core, :3], rgb[core].astype(np.uint8))
    return native, {"source_tile_bbox": bbox, "square_crop": [crop_x, crop_y, side],
                    "unchanged_opaque_source_pixels": int(core.sum()),
                    "boundary_matting_pixels": int(ring.sum())}


def resize(image, size):
    # Pillow's RGBA resampling uses premultiplied alpha to avoid matte halos.
    out = image.resize((size, size), Image.Resampling.LANCZOS)
    rgba = np.asarray(out).copy()
    # Lanczos has distant positive lobes (e.g. alpha=2 in a 24px corner).
    # Limit those lobes to actual source coverage; do not leave ghost corners.
    coverage = np.asarray(image.getchannel("A").resize((size, size), Image.Resampling.BOX))
    rgba[coverage == 0, 3] = 0
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba)


def ico_frames(path):
    data = path.read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", data)
    assert (reserved, kind, count) == (0, 1, len(SIZES))
    frames = []
    for index in range(count):
        w, h, _, _, planes, depth, length, offset = struct.unpack_from(
            "<BBBBHHII", data, 6 + 16 * index)
        size = w or 256
        assert size == (h or 256) and planes == 1 and depth == 32
        payload = data[offset:offset + length]
        # DIB entries for small sizes retain compatibility with Win32 resource
        # consumers; Windows supports a lossless PNG entry for the 256px image.
        frames.append({"size": size, "bytes": length,
                       "encoding": "PNG" if payload.startswith(b"\x89PNG") else "DIB32"})
    decoded = Image.open(path)
    assert sorted(decoded.ico.sizes()) == [(n, n) for n in SIZES]
    for size in SIZES:
        assert np.array_equal(np.asarray(decoded.ico.getimage((size, size))),
                              np.asarray(Image.open(ICONS / f"{size}x{size}.png")))
    return frames


def write_ico(images):
    payloads = []
    for size, image in images.items():
        if size == 256:
            stream = io.BytesIO()
            image.save(stream, format="PNG")
            payload = stream.getvalue()
        else:
            pixels = np.asarray(image)[::-1, :, [2, 1, 0, 3]].tobytes()
            mask_row = ((size + 31) // 32) * 4
            mask = bytearray(mask_row * size)
            alpha = np.asarray(image)[::-1, :, 3]
            for y, x in np.argwhere(alpha == 0):
                mask[y * mask_row + x // 8] |= 0x80 >> (x % 8)
            payload = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32,
                                  0, len(pixels), 0, 0, 0, 0) + pixels + mask
        payloads.append((size, payload))
    offset = 6 + 16 * len(payloads)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(payloads)))
    for size, payload in payloads:
        directory += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0,
                                 1, 32, len(payload), offset)
        offset += len(payload)
    (ICONS / "icon.ico").write_bytes(directory + b"".join(p for _, p in payloads))


def preview(images):
    sheet = Image.new("RGB", (1000, 740), "#e8e9ec")
    draw = ImageDraw.Draw(sheet)
    draw.text((20, 12), "PLIX / approved pixels / light and dark backgrounds", fill="#222222")
    for row, background in enumerate(("#ffffff", "#17191f")):
        top = 42 + row * 345
        draw.rectangle((12, top, 988, top + 332), fill=background)
        color = "#222222" if row == 0 else "#eeeeee"
        x = 30
        for size in SIZES:
            image = images[size]
            draw.text((x, top + 10), f"{size}px", fill=color)
            sheet.paste(image, (x, top + 42), image)
            if size <= 64:
                zoom = image.resize((96, 96), Image.Resampling.NEAREST)
                sheet.paste(zoom, (x, top + 150), zoom)
            x += max(112, size + 12)
    sheet.save(BRAND / "preview-light-dark.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=BRAND / "approved-original.png")
    args = parser.parse_args()
    BRAND.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(exist_ok=True)
    source_path = BRAND / "approved-original.png"
    if args.source.resolve() != source_path.resolve():
        if source_path.exists():
            assert digest(source_path) == digest(args.source), "Approved source differs"
        else:
            shutil.copy2(args.source, source_path)
    source_hash = digest(source_path)
    assert source_hash == SOURCE_SHA256, "Use the approved original, not a replacement"
    provenance_path = BRAND / "verification.json"
    if provenance_path.exists():
        assert json.loads(provenance_path.read_text())["source_sha256"] == source_hash
    native, details = extract(Image.open(source_path))
    native.save(BRAND / "tile-transparent-native.png")
    images = {size: resize(native, size) for size in SIZES}
    for size in (*SIZES, 512, 1024):
        resize(native, size).save(ICONS / f"{size}x{size}.png")
    resize(native, 1024).save(ICONS / "icon.png")
    write_ico(images)
    frames = ico_frames(ICONS / "icon.ico")
    checks = []
    for size, image in images.items():
        rgba = np.asarray(image)
        alpha = rgba[:, :, 3]
        assert image.mode == "RGBA"
        assert all(alpha[y, x] == 0 for y, x in ((0, 0), (0, -1), (-1, 0), (-1, -1)))
        assert 0 < np.count_nonzero((alpha > 0) & (alpha < 255))
        assert alpha.max() == 255
        # Light neutral source backdrop cannot remain in visible corner pixels.
        pale = (rgba[:, :, :3].min(2) > 180) & (np.ptp(rgba[:, :, :3], axis=2) < 25)
        assert not np.any(pale & (alpha > 0))
        # The original Play aperture remains visibly darker than the P stem.
        stem = np.asarray(image.convert("RGB"))[round(size * .48), round(size * .36)].mean()
        play = np.asarray(image.convert("RGB"))[round(size * .44), round(size * .52)].mean()
        assert stem > play + 45
        checks.append({"size": size, "alpha_extrema": [int(alpha.min()), int(alpha.max())],
                       "transparent_corners": True, "pale_backdrop_pixels": 0,
                       "P_to_Play_mean_RGB_difference": round(float(stem - play), 2)})
    preview(images)
    report = {"source_sha256": source_hash, "source_size": [1254, 1254],
              "method": "Original RGB; scanline silhouette extraction; 1px edge unmatting; premultiplied-alpha Lanczos",
              "small_size_variant": "Same approved art; no alternate letter or sharpening",
              **details, "ico_frames": frames, "png_checks": checks}
    provenance_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
