// Generates the extension icons (pure Node, no dependencies).
// Usage: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const BG = [15, 23, 42, 255];
const WHITE = [229, 231, 235, 255];
const GREEN = [74, 222, 128, 255];

function insideRoundedRect(x, y, r) {
  let dx = 0;
  let dy = 0;
  if (x < r.x0 + r.rad) dx = r.x0 + r.rad - x;
  else if (x > r.x1 - r.rad) dx = x - (r.x1 - r.rad);
  if (y < r.y0 + r.rad) dy = r.y0 + r.rad - y;
  else if (y > r.y1 - r.rad) dy = y - (r.y1 - r.rad);
  return dx * dx + dy * dy <= r.rad * r.rad;
}

function inRect(x, y, rect) {
  return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

function inRound(rect, x, y) {
  if (!inRect(x, y, rect)) return false;
  return insideRoundedRect(x, y, rect);
}

function inStroke(rect, x, y, width) {
  return (
    inRound(rect, x, y) &&
    !inRound({ x0: rect.x0 + width, y0: rect.y0 + width, x1: rect.x1 - width, y1: rect.y1 - width, rad: Math.max(0, rect.rad - width) }, x, y)
  );
}

function render(size, scale) {
  const S = size * scale;
  const px = new Uint8ClampedArray(size * size * 4);

  const back = { x0: 0.27 * S, y0: 0.2 * S, x1: 0.64 * S, y1: 0.66 * S, rad: 0.09 * S };
  const front = { x0: 0.39 * S, y0: 0.36 * S, x1: 0.77 * S, y1: 0.84 * S, rad: 0.09 * S };
  const backStroke = 0.065 * S;
  const frontStroke = 0.075 * S;
  const bg = { x0: 0.03 * S, y0: 0.03 * S, x1: 0.97 * S, y1: 0.97 * S, rad: 0.22 * S };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const X = x * scale + sx + 0.5;
          const Y = y * scale + sy + 0.5;
          let color = null;

          if (inRound(bg, X, Y)) {
            color = BG;
            if (inStroke(front, X, Y, frontStroke)) color = GREEN;
            else if (inRound(front, X, Y)) color = BG;
            else if (inStroke(back, X, Y, backStroke)) color = WHITE;
            else {
              // a soft green dot in the lower right, for a bit of character
              const dx = X - 0.79 * S;
              const dy = Y - 0.79 * S;
              if (dx * dx + dy * dy < (0.045 * S) * (0.045 * S)) color = GREEN;
            }
          } else {
            color = [0, 0, 0, 0];
          }

          r += color[0] * color[3];
          g += color[1] * color[3];
          b += color[2] * color[3];
          a += color[3];
        }
      }

      const idx = (y * size + x) * 4;
      if (a === 0) {
        px[idx] = 0;
        px[idx + 1] = 0;
        px[idx + 2] = 0;
        px[idx + 3] = 0;
      } else {
        px[idx] = Math.round(r / a);
        px[idx + 1] = Math.round(g / a);
        px[idx + 2] = Math.round(b / a);
        px[idx + 3] = Math.round(a / (scale * scale));
      }
    }
  }

  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy
      ? rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
      : Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const rgba = Buffer.from(render(size, size <= 32 ? 8 : 4));
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), encodePng(size, rgba));
  console.log(`icon${size}.png`);
}
