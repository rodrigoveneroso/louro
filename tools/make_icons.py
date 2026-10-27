"""Draw the extension icons from the full-body logo and standalone head.

    python3 tools/make_icons.py

The whole parrot appears only at 128 px; use the standalone head at 48, 32, and 16 px,
where the full bird would be too small to recognise. Needs Pillow; regenerate the icons
with this script instead of editing them by hand.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "assets" / "logo.png"
HEAD = ROOT / "assets" / "head.png"
OUT = ROOT / "extension" / "icons"


def square(image: Image.Image) -> Image.Image:
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def main() -> None:
    logo = Image.open(LOGO).convert("RGBA")
    whole = square(logo.crop(logo.getbbox()))
    head = Image.open(HEAD).convert("RGBA")
    # The toolbar canvas is square. Remove transparent top/bottom margins and use
    # that full canvas so the head reads at the same visual size as other icons.
    visible_alpha = head.getchannel("A").point(lambda value: 255 if value >= 32 else 0)
    head = head.crop(visible_alpha.getbbox())
    head = head.resize((max(head.size), max(head.size)), Image.LANCZOS)
    for size, source in ((128, whole), (48, head), (32, head), (16, head)):
        source.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
        print(f"wrote extension/icons/icon{size}.png")


if __name__ == "__main__":
    main()
