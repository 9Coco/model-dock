import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// Code-native brand artwork, rasterized from the same simple geometry as SVG.
// No graphics runtime or external image downloads are needed to reproduce it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="ModelDock">
  <rect x="4" y="4" width="248" height="248" rx="58" fill="#353a44"/>
  <rect x="6" y="6" width="244" height="244" rx="56" fill="#191c23"/>
  <path d="M64 176V80L128 142L192 80V176" fill="none" stroke="#eef2f7" stroke-width="22" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M64 80L128 142L192 80" fill="none" stroke="#60a5fa" stroke-width="20" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M88 193H168" fill="none" stroke="#60a5fa" stroke-width="10" stroke-linecap="round"/>
</svg>\n`;
const colors = { border: [53, 58, 68], tile: [25, 28, 35], white: [238, 242, 247], blue: [96, 165, 250] };
const withinRounded = (x, y, left, top, width, height, radius) => {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return x >= left && x <= left + width && y >= top && y <= top + height && dx * dx + dy * dy <= radius * radius;
};
function nearSegment(x, y, ax, ay, bx, by, radius) {
  const dx = bx - ax, dy = by - ay, fraction = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - fraction * dx) ** 2 + (y - ay - fraction * dy) ** 2 <= radius * radius;
}
function colorAt(x, y) {
  let color = null;
  if (withinRounded(x, y, 4, 4, 248, 248, 58)) color = colors.border;
  if (withinRounded(x, y, 6, 6, 244, 244, 56)) color = colors.tile;
  if (nearSegment(x, y, 64, 176, 64, 80, 11) || nearSegment(x, y, 64, 80, 128, 142, 11) || nearSegment(x, y, 128, 142, 192, 80, 11) || nearSegment(x, y, 192, 80, 192, 176, 11)) color = colors.white;
  if (nearSegment(x, y, 64, 80, 128, 142, 10) || nearSegment(x, y, 128, 142, 192, 80, 10) || nearSegment(x, y, 88, 193, 168, 193, 5)) color = colors.blue;
  return color;
}
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }
function chunk(type, payload) { const code = Buffer.from(type), prefix = Buffer.alloc(4), suffix = Buffer.alloc(4); prefix.writeUInt32BE(payload.length); suffix.writeUInt32BE(crc32(Buffer.concat([code, payload]))); return Buffer.concat([prefix, code, payload, suffix]); }
function png(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1)), samples = 4, scale = 256 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let count = 0, red = 0, green = 0, blue = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const color = colorAt((x + (sx + .5) / samples) * scale, (y + (sy + .5) / samples) * scale);
      if (color) { count++; red += color[0]; green += color[1]; blue += color[2]; }
    }
    const index = y * (size * 4 + 1) + 1 + x * 4;
    if (count) { rows[index] = Math.round(red / count); rows[index + 1] = Math.round(green / count); rows[index + 2] = Math.round(blue / count); rows[index + 3] = Math.round(count / (samples * samples) * 255); }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const assets = join(root, 'assets'), publicDir = join(root, 'public'); mkdirSync(assets, { recursive: true }); mkdirSync(publicDir, { recursive: true });
writeFileSync(join(assets, 'modeldock.svg'), svg); writeFileSync(join(publicDir, 'modeldock.svg'), svg);
const sizes = [16, 24, 32, 48, 64, 128, 256], images = sizes.map(size => png(size));
const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => { const entry = 6 + index * 16; header[entry] = size === 256 ? 0 : size; header[entry + 1] = size === 256 ? 0 : size; header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += images[index].length; });
writeFileSync(join(assets, 'modeldock.ico'), Buffer.concat([header, ...images]));
writeFileSync(join(assets, 'modeldock.png'), png(512));
writeFileSync(join(assets, 'modeldock-tray.png'), images[sizes.indexOf(32)]);
console.log(`ModelDock icons generated: SVG, 512 px PNG, 32 px tray PNG, ICO ${sizes.join('/')}.`);
