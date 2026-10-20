/**
 * Builds assets/icon.ico from assets/icon.png for Windows only.
 * icon.png and icon.icns stay untouched so the macOS icon does not change.
 *
 * The source PNG has a wide white margin. Windows taskbar and title-bar
 * slots are small, so that margin makes the mark look tiny. This crops to
 * the logo and writes a multi-size .ico.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const assetsDir = path.join(__dirname, '..', 'assets');
const pngPath = path.join(assetsDir, 'icon.png');
const icoPath = path.join(assetsDir, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);
  let offset = 8;
  const idats = [];
  let width = 0;
  let height = 0;
  let colorType = 6;

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString();
    const data = buf.slice(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (colorType !== 6) {
    throw new Error(`Expected an RGBA PNG, got color type ${colorType}`);
  }

  const bpp = 4;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };

  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[cursor];
      cursor += 1;
      const left = x >= bpp ? pixels[row + x - bpp] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[row - stride + x - bpp] : 0;
      let decoded = value;
      if (filter === 1) decoded = (value + left) & 255;
      else if (filter === 2) decoded = (value + up) & 255;
      else if (filter === 3) decoded = (value + ((left + up) >> 1)) & 255;
      else if (filter === 4) decoded = (value + paeth(left, up, upLeft)) & 255;
      pixels[row + x] = decoded;
    }
  }

  return { width, height, pixels };
}

function isBackground(pixels, index) {
  const r = pixels[index];
  const g = pixels[index + 1];
  const b = pixels[index + 2];
  const a = pixels[index + 3];
  return a < 20 || (r > 248 && g > 248 && b > 248);
}

function cropToLogo(image) {
  const { width, height, pixels } = image;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (isBackground(pixels, index)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error('Could not find logo pixels in icon.png');
  }

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const pad = Math.round(Math.max(contentWidth, contentHeight) * 0.02);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);
  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const side = Math.max(cropWidth, cropHeight);
  const originX = Math.max(0, Math.min(width - side, left - Math.floor((side - cropWidth) / 2)));
  const originY = Math.max(0, Math.min(height - side, top - Math.floor((side - cropHeight) / 2)));
  const cropped = Buffer.alloc(side * side * 4, 0);

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const srcX = originX + x;
      const srcY = originY + y;
      const dst = (y * side + x) * 4;
      if (srcX >= width || srcY >= height) continue;
      const src = (srcY * width + srcX) * 4;
      pixels.copy(cropped, dst, src, src + 4);
    }
  }

  return { width: side, height: side, pixels: cropped };
}

function scaleBox(image, size) {
  const { width, height, pixels } = image;
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor((y * height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor((x * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * width + sx) * 4;
          const alpha = pixels[index + 3];
          r += pixels[index] * alpha;
          g += pixels[index + 1] * alpha;
          b += pixels[index + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }
      const dst = (y * size + x) * 4;
      if (a === 0 || count === 0) continue;
      out[dst] = Math.round(r / a);
      out[dst + 1] = Math.round(g / a);
      out[dst + 2] = Math.round(b / a);
      out[dst + 3] = Math.round(a / count);
    }
  }

  return out;
}

function bmpEntry(size, pixels) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const src = (srcY * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = pixels[src + 2];
      xor[dst + 1] = pixels[src + 1];
      xor[dst + 2] = pixels[src];
      xor[dst + 3] = pixels[src + 3];
    }
  }

  return Buffer.concat([header, xor]);
}

function writeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(images.length * 16);
  let offset = 6 + entries.length;
  const blobs = images.map(({ size, pixels }) => {
    const blob = bmpEntry(size, pixels);
    return { size, blob };
  });

  blobs.forEach(({ size, blob }, index) => {
    const entry = index * 16;
    entries[entry] = size >= 256 ? 0 : size;
    entries[entry + 1] = size >= 256 ? 0 : size;
    entries.writeUInt16LE(1, entry + 4);
    entries.writeUInt16LE(32, entry + 6);
    entries.writeUInt32LE(blob.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += blob.length;
  });

  fs.writeFileSync(icoPath, Buffer.concat([header, entries, ...blobs.map((item) => item.blob)]));
}

const cropped = cropToLogo(decodePng(pngPath));
const images = SIZES.map((size) => ({ size, pixels: scaleBox(cropped, size) }));
writeIco(images);
console.log(`Wrote ${path.relative(path.join(__dirname, '..'), icoPath)} from a ${cropped.width}px crop of icon.png`);
