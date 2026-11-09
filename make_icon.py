"""Generate GeneForge's app icon with the standard library alone."""
import math, struct, zlib, sys

S = 1024

def png(path, pixels):
    raw = b"".join(b"\x00" + bytes(row) for row in pixels)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        fh.write(chunk(b"IEND", b""))

def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))

TOP, BOT = (38, 70, 120), (16, 24, 38)
STRAND_A, STRAND_B, RUNG = (120, 190, 255), (126, 224, 190), (210, 228, 245)
R = S * 0.22            # corner radius

rows = []
for y in range(S):
    row = bytearray()
    for x in range(S):
        # rounded-square mask with a soft edge
        dx = max(R - x, 0, x - (S - 1 - R))
        dy = max(R - y, 0, y - (S - 1 - R))
        d = math.hypot(dx, dy)
        alpha = 255 if d <= R - 1 else (0 if d >= R + 1 else round(255 * (R + 1 - d) / 2))
        r, g, b = mix(TOP, BOT, y / S)

        # two helical strands plus their rungs
        t = (y - S * 0.12) / (S * 0.76)
        if 0.0 <= t <= 1.0:
            phase = t * math.pi * 3.1
            amp, mid = S * 0.185, S * 0.5
            xa, xb = mid + amp * math.sin(phase), mid - amp * math.sin(phase)
            thick = S * 0.045 * (0.55 + 0.45 * abs(math.cos(phase)))
            if abs(x - xa) < thick:
                r, g, b = mix((r, g, b), STRAND_A, 1 - abs(x - xa) / thick)
            if abs(x - xb) < thick:
                r, g, b = mix((r, g, b), STRAND_B, 1 - abs(x - xb) / thick)
            if math.sin(phase * 2) > 0.62 and min(xa, xb) < x < max(xa, xb):
                if abs((y - S * 0.12) % (S * 0.076)) < S * 0.012:
                    r, g, b = mix((r, g, b), RUNG, 0.75)
        row += bytes((r, g, b, alpha))
    rows.append(row)

png(sys.argv[1] if len(sys.argv) > 1 else "icon_1024.png", rows)
print("icon written")
