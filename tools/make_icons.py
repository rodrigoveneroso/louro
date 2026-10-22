"""Draw the extension icons from the 👻 emoji the side panel already uses.

    python3 tools/make_icons.py [path/to/NotoColorEmoji.ttf]

Uses Google's Noto Color Emoji (Apache-2.0), the font most Linux desktops ship. It is a
bitmap font drawn at one fixed size, so the glyph is rendered there and scaled down.
Needs Pillow; regenerate the icons with this script instead of editing them by hand.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GHOST = "\N{GHOST}"
NATIVE_SIZE = 109  # the only size Noto Color Emoji's bitmaps come in
SIZES = (16, 32, 48, 128)
DEFAULT_FONT = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"


def render(font_path: str) -> Image.Image:
    font = ImageFont.truetype(font_path, NATIVE_SIZE)
    canvas = Image.new("RGBA", (NATIVE_SIZE * 2, NATIVE_SIZE * 2), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((NATIVE_SIZE // 2, NATIVE_SIZE // 2), GHOST, font=font, embedded_color=True)
    glyph = canvas.crop(canvas.getbbox())
    # square, with a little air around the ghost so it does not touch the edges
    side = int(max(glyph.size) * 1.08)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2))
    return square


def main() -> None:
    ghost = render(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FONT)
    for size in SIZES:
        ghost.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
