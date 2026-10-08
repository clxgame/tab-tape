// Deterministic small toolbar artwork, drawn without runtime dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const label = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([size, label, data, crc]);
}
for (const size of [16, 48, 128]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x + 0.5) / size; const fy = (y + 0.5) / size;
    const cx = Math.max(0.2, Math.min(0.8, fx)); const cy = Math.max(0.2, Math.min(0.8, fy));
    const inside = Math.hypot(fx - cx, fy - cy) < 0.19;
    const bars = [[0.26, 0.16], [0.42, 0.30], [0.58, 0.23], [0.74, 0.11]];
    const wave = bars.some(([center, height]) => Math.abs(fx - center) < 0.045 && Math.abs(fy - 0.5) < height);
    const color = wave ? [198, 242, 145] : [24, 30, 29];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    pixels.set([...color, inside ? 255 : 0], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}
