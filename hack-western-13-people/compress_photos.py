"""Keep every photo small: longest side 512 px, JPEG quality 85.

  python3 compress_photos.py      # after photos.py or any new photo lands

Faces need about 112 px, so 512 keeps them sharp at a fraction of the size.
A file whose name changes (.png or .webp to .jpg) is renamed everywhere it is
written: the CSVs, JSONs, scripts, the gallery page and the spreadsheet.
"""
from pathlib import Path
import io

from PIL import Image

D = Path(__file__).resolve().parent
PHOTO_DIRS = ["photos", "photos-linkedin", "photos-fallback", "hackwestern-site/photos", "faces"]
TYPES = {".png", ".jpg", ".jpeg", ".webp"}
TEXT = {".csv", ".json", ".py", ".html", ".md"}
SIDE, QUALITY = 512, 85


def shrink(data: bytes) -> bytes:
    """Any image bytes in, a small JPEG out."""
    img = Image.open(io.BytesIO(data))
    img.thumbnail((SIDE, SIDE))
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        flat = Image.new("RGB", img.size, "white")
        flat.paste(img, mask=img.getchannel("A"))
        img = flat
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    return out.getvalue()


def main():
    renamed, before, after = {}, 0, 0
    for folder in PHOTO_DIRS:
        for path in sorted((D / folder).rglob("*")):
            if path.suffix.lower() not in TYPES:
                continue
            data = path.read_bytes()
            if path.suffix.lower() in (".jpg", ".jpeg"):
                try:
                    with Image.open(io.BytesIO(data)) as im:
                        if im.format == "JPEG" and max(im.size) <= SIDE:
                            before += len(data); after += len(data)
                            continue  # already a small JPEG; re-encoding only churns git
                except Exception:
                    pass
            small = shrink(data)
            before += len(data)
            target = path.with_suffix(".jpg")
            if target == path and len(small) >= len(data):
                after += len(data)  # already small
                continue
            target.write_bytes(small)
            after += len(small)
            if target != path:
                path.unlink()
                assert path.name not in renamed, f"two photos named {path.name}"
                renamed[path.name] = target.name
    for f in D.rglob("*"):
        if f.suffix in TEXT and f.is_file() and f.name != Path(__file__).name:
            text = f.read_text()
            new = text
            for old, nu in renamed.items():
                new = new.replace(old, nu)
            if new != text:
                f.write_text(new)
    xlsx = D / "hack-western-13-slack-members.xlsx"
    if renamed and xlsx.exists():
        from openpyxl import load_workbook
        wb = load_workbook(xlsx)
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                for c in row:
                    if isinstance(c.value, str) and c.value in renamed:
                        c.value = renamed[c.value]
                    if c.hyperlink is not None and c.hyperlink.target:
                        for old, nu in renamed.items():
                            if c.hyperlink.target.endswith(old):
                                c.hyperlink.target = c.hyperlink.target[: -len(old)] + nu
        wb.save(xlsx)
    print(f"photos: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB, {len(renamed)} renamed to .jpg")


if __name__ == "__main__":
    main()
