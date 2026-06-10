// Run: node scripts/generate-icons.js
// Generates PNG icons for the Chrome extension using pure Node (no dependencies).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPNG(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const cx = x - size / 2;
      const cy = y - size / 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const inCircle = dist < size * 0.42;
      const idx = row + 1 + x * 4;
      if (inCircle) {
        raw[idx] = 99;      // R
        raw[idx + 1] = 102; // G
        raw[idx + 2] = 241; // B
        raw[idx + 3] = 255; // A
      } else {
        raw[idx + 3] = 0;
      }
    }
  }

  const compressed = zlib.deflateSync(raw);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeB = Buffer.from(type);
    const crcBuf = Buffer.concat([typeB, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf), 0);
    return Buffer.concat([len, typeB, data, crc]);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

[16, 48, 128].forEach((size) => {
  const file = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(file, createPNG(size));
  console.log(`Created ${file}`);
});
