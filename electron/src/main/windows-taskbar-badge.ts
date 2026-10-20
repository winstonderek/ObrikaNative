import { BrowserWindow, nativeImage, type NativeImage } from 'electron';
import zlib from 'node:zlib';

/** Obrika brand blue — same as the desktop loading screen. */
const BADGE_BLUE = { r: 0x1c, g: 0x45, b: 0xfa };
const BADGE_SIZE = 32;

const overlayCache = new Map<string, NativeImage>();

/** 5×7 bitmap for digits 0–9 and '+'. Each row is a 5-bit mask. */
const GLYPH_5X7: Record<string, number[]> = {
  '0': [0b01110, 0b10001, 0b10001, 0b10011, 0b10101, 0b11001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b01110, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
};

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodeRgbaPng(size: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + size * 4;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawCircle(pixels: Buffer, size: number): void {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const outer = size / 2 - 0.5;
  const inner = outer - 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      const outerAlpha = Math.max(0, Math.min(1, outer - dist + 0.5));
      if (outerAlpha <= 0) continue;

      const innerAlpha = Math.max(0, Math.min(1, inner - dist + 0.5));
      const i = (y * size + x) * 4;
      const r = BADGE_BLUE.r * innerAlpha + 255 * (1 - innerAlpha);
      const g = BADGE_BLUE.g * innerAlpha + 255 * (1 - innerAlpha);
      const b = BADGE_BLUE.b * innerAlpha + 255 * (1 - innerAlpha);
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      pixels[i + 3] = Math.round(255 * outerAlpha);
    }
  }
}

function glyphScale(label: string): number {
  if (label.length <= 1) return 3;
  if (label.length === 2) return 2;
  return 1;
}

function drawLabel(pixels: Buffer, size: number, label: string): void {
  const scale = glyphScale(label);
  const glyphW = 5;
  const glyphH = 7;
  const gap = 1;
  const textW = label.length * glyphW * scale + (label.length - 1) * gap * scale;
  const textH = glyphH * scale;
  const originX = Math.floor((size - textW) / 2);
  const originY = Math.floor((size - textH) / 2);

  for (let index = 0; index < label.length; index++) {
    const rows = GLYPH_5X7[label[index]];
    if (!rows) continue;
    const glyphX = originX + index * (glyphW + gap) * scale;

    for (let row = 0; row < glyphH; row++) {
      for (let col = 0; col < glyphW; col++) {
        if (((rows[row] >> (glyphW - 1 - col)) & 1) === 0) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = glyphX + col * scale + dx;
            const y = originY + row * scale + dy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const i = (y * size + x) * 4;
            if (pixels[i + 3] === 0) continue;
            pixels[i] = 255;
            pixels[i + 1] = 255;
            pixels[i + 2] = 255;
          }
        }
      }
    }
  }
}

function createOverlayIcon(label: string): NativeImage {
  const cached = overlayCache.get(label);
  if (cached) return cached;

  const pixels = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4);
  drawCircle(pixels, BADGE_SIZE);
  drawLabel(pixels, BADGE_SIZE, label);

  const icon = nativeImage.createFromBuffer(encodeRgbaPng(BADGE_SIZE, pixels));
  overlayCache.set(label, icon);
  return icon;
}

/**
 * Windows `app.setBadgeCount` draws Chromium's default overlay (black).
 * Replace it with a blue circle so the taskbar badge matches Obrika branding.
 */
export function applyWindowsTaskbarBadge(count: number): void {
  const label = count > 99 ? '99+' : String(count);
  const icon = count > 0 ? createOverlayIcon(label) : null;
  const description = count > 0 ? `${label} unread` : '';

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.setOverlayIcon(icon, description);
  }
}
