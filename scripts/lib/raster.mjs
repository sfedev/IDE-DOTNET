/**
 * Rasterizador mínimo para dibujar el logo de DotForge sin dependencias gráficas.
 *
 * Trabaja con supermuestreo (se dibuja a 4x y se reduce), que es la forma más simple de conseguir
 * bordes suaves sin implementar un antialiasing de verdad.
 */

const SUPERSAMPLE = 4;

export class Canvas {
  constructor(size) {
    this.size = size * SUPERSAMPLE;
    this.scale = SUPERSAMPLE;
    this.pixels = new Float32Array(this.size * this.size * 4);
  }

  /** Mezcla un color sobre un píxel usando alpha compositing "source-over". */
  blend(x, y, r, g, b, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.size || y >= this.size) return;

    const index = (y * this.size + x) * 4;
    const dstA = this.pixels[index + 3];
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;

    for (let channel = 0; channel < 3; channel++) {
      const src = [r, g, b][channel];
      const dst = this.pixels[index + channel];
      this.pixels[index + channel] = (src * a + dst * dstA * (1 - a)) / outA;
    }
    this.pixels[index + 3] = outA;
  }

  /** Rellena un rectángulo redondeado con un degradado vertical entre dos colores. */
  roundedRectGradient(x0, y0, x1, y1, radius, colorTop, colorBottom) {
    const s = this.scale;
    const left = x0 * s;
    const top = y0 * s;
    const right = x1 * s;
    const bottom = y1 * s;
    const r = radius * s;

    for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
      const t = (y - top) / (bottom - top);
      const color = mix(colorTop, colorBottom, t);

      for (let x = Math.floor(left); x < Math.ceil(right); x++) {
        if (!insideRoundedRect(x + 0.5, y + 0.5, left, top, right, bottom, r)) continue;
        this.blend(x, y, color[0], color[1], color[2], 1);
      }
    }
  }

  /** Traza un segmento de grosor `width` con extremos redondeados. */
  stroke(points, width, color, alpha = 1) {
    const s = this.scale;
    const half = (width * s) / 2;

    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      const x0 = ax * s;
      const y0 = ay * s;
      const x1 = bx * s;
      const y1 = by * s;

      const minX = Math.floor(Math.min(x0, x1) - half - 1);
      const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
      const minY = Math.floor(Math.min(y0, y1) - half - 1);
      const maxY = Math.ceil(Math.max(y0, y1) + half + 1);

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const distance = distanceToSegment(x + 0.5, y + 0.5, x0, y0, x1, y1);
          if (distance <= half) this.blend(x, y, color[0], color[1], color[2], alpha);
        }
      }
    }
  }

  /** Reduce el supermuestreo y devuelve el RGBA final. */
  toRgba(targetSize) {
    const factor = this.size / targetSize;
    const out = new Uint8Array(targetSize * targetSize * 4);

    for (let y = 0; y < targetSize; y++) {
      for (let x = 0; x < targetSize; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let samples = 0;

        for (let sy = 0; sy < factor; sy++) {
          for (let sx = 0; sx < factor; sx++) {
            const px = Math.floor(x * factor + sx);
            const py = Math.floor(y * factor + sy);
            const index = (py * this.size + px) * 4;
            const alpha = this.pixels[index + 3];
            r += this.pixels[index] * alpha;
            g += this.pixels[index + 1] * alpha;
            b += this.pixels[index + 2] * alpha;
            a += alpha;
            samples++;
          }
        }

        const outIndex = (y * targetSize + x) * 4;
        if (a > 0) {
          out[outIndex] = clamp255((r / a) * 255);
          out[outIndex + 1] = clamp255((g / a) * 255);
          out[outIndex + 2] = clamp255((b / a) * 255);
        }
        out[outIndex + 3] = clamp255((a / samples) * 255);
      }
    }

    return out;
  }
}

function clamp255(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function insideRoundedRect(px, py, left, top, right, bottom, radius) {
  if (px < left || px > right || py < top || py > bottom) return false;

  const corners = [
    [left + radius, top + radius, px < left + radius && py < top + radius],
    [right - radius, top + radius, px > right - radius && py < top + radius],
    [left + radius, bottom - radius, px < left + radius && py > bottom - radius],
    [right - radius, bottom - radius, px > right - radius && py > bottom - radius],
  ];

  for (const [cx, cy, applies] of corners) {
    if (applies) {
      const dx = px - cx;
      const dy = py - cy;
      return dx * dx + dy * dy <= radius * radius;
    }
  }

  return true;
}

function distanceToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return Math.hypot(px - x0, py - y0);

  let t = ((px - x0) * dx + (py - y0) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Convierte "#RRGGBB" a [r, g, b] normalizado 0..1. */
export function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}
