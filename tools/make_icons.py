"""Draw the extension icons from assets/logo.png.

    python3 tools/make_icons.py

The whole parrot at 128 and 48 px; at 32 and 16 px, the size of the toolbar and the Meet
button, only its head with the headphones, which stays recognisable where the whole
bird would be a smudge. Needs Pillow; regenerate the icons with this script instead of
editing them by hand.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "assets" / "logo.png"
OUT = ROOT / "extension" / "icons"
HEAD = (62, 28, 218, 140)  # left, top, right, bottom of the head in the 256 px logo


def square(image: Image.Image) -> Image.Image:
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def main() -> None:
    logo = Image.open(LOGO).convert("RGBA")
    whole = square(logo.crop(logo.getbbox()))
    head = square(logo.crop(HEAD))
    for size, source in ((128, whole), (48, whole), (32, head), (16, head)):
        source.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
        print(f"wrote extension/icons/icon{size}.png")


if __name__ == "__main__":
    main()
