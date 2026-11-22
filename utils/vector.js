// Vectors are stored as packed float32 (768 dims = 3KB) and pre-normalised, so
// similarity is a plain dot product. Keeps retrieval cheap on a 2-core box.

export function normalizeVector(values = []) {
  let sumSquares = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i]) || 0;
    sumSquares += value * value;
  }
  const magnitude = Math.sqrt(sumSquares);
  const unit = new Float32Array(values.length);
  if (!magnitude) return unit;
  for (let i = 0; i < values.length; i += 1) {
    unit[i] = (Number(values[i]) || 0) / magnitude;
  }
  return unit;
}

export function packVector(values = []) {
  const unit = values instanceof Float32Array ? values : normalizeVector(values);
  return Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength);
}

export function unpackVector(buffer) {
  if (!buffer) return new Float32Array(0);
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer || buffer);
  if (bytes.byteLength % 4 !== 0) return new Float32Array(0);
  // Copy when the slice is not 4-byte aligned; Float32Array cannot view it otherwise.
  if ((bytes.byteOffset & 3) === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const copy = Buffer.from(bytes);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function dotProduct(a, b) {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) total += a[i] * b[i];
  return total;
}

// Partial selection beats a full sort when k is small relative to the candidates.
export function topK(items = [], k = 8) {
  if (k >= items.length) return [...items].sort((a, b) => b.score - a.score);
  const best = [];
  for (const item of items) {
    if (best.length < k) {
      best.push(item);
      if (best.length === k) best.sort((a, b) => a.score - b.score);
      continue;
    }
    if (item.score <= best[0].score) continue;
    best[0] = item;
    let i = 0;
    while (i + 1 < k && best[i].score > best[i + 1].score) {
      const swap = best[i];
      best[i] = best[i + 1];
      best[i + 1] = swap;
      i += 1;
    }
  }
  return best.sort((a, b) => b.score - a.score);
}
