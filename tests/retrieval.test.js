import test from "node:test";
import assert from "node:assert/strict";
import { dotProduct, normalizeVector, packVector, topK, unpackVector } from "../utils/vector.js";
import { splitIntoChunks } from "../services/knowledgeIndexService.js";

function magnitude(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

test("vectors are normalised so similarity is a dot product", () => {
  const unit = normalizeVector([3, 4]);
  assert.ok(Math.abs(magnitude([...unit]) - 1) < 1e-6);
  assert.ok(Math.abs(unit[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(unit[1] - 0.8) < 1e-6);
});

test("a zero vector normalises without producing NaN", () => {
  const unit = normalizeVector([0, 0, 0]);
  assert.deepEqual([...unit], [0, 0, 0]);
});

test("packing round-trips through the stored buffer", () => {
  const values = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  const packed = packVector(values);
  assert.equal(packed.byteLength, 768 * 4, "768 dims should occupy 3KB");
  const restored = unpackVector(packed);
  assert.equal(restored.length, 768);
  const expected = normalizeVector(values);
  for (let i = 0; i < 768; i += 1) {
    assert.ok(Math.abs(restored[i] - expected[i]) < 1e-6, `dim ${i} drifted`);
  }
});

test("an unaligned buffer still unpacks correctly", () => {
  const values = [1, 0, 0, 0];
  const packed = packVector(values);
  // Mongo can hand back a slice whose byteOffset is not a multiple of four.
  const padded = Buffer.concat([Buffer.alloc(1), packed]);
  const restored = unpackVector(padded.subarray(1));
  assert.equal(restored.length, 4);
  assert.ok(Math.abs(restored[0] - 1) < 1e-6);
});

test("a truncated buffer yields nothing rather than garbage", () => {
  assert.equal(unpackVector(Buffer.alloc(7)).length, 0);
  assert.equal(unpackVector(null).length, 0);
});

test("identical text scores higher than unrelated text", () => {
  const query = normalizeVector([1, 0, 0]);
  const same = normalizeVector([1, 0, 0]);
  const orthogonal = normalizeVector([0, 1, 0]);
  assert.ok(dotProduct(query, same) > dotProduct(query, orthogonal));
  assert.ok(Math.abs(dotProduct(query, same) - 1) < 1e-6);
  assert.ok(Math.abs(dotProduct(query, orthogonal)) < 1e-6);
});

test("topK returns the best scores in descending order", () => {
  const items = [0.1, 0.9, 0.5, 0.3, 0.7].map((score, index) => ({ score, index }));
  const best = topK(items, 3);
  assert.deepEqual(best.map((item) => item.score), [0.9, 0.7, 0.5]);
});

test("topK handles k larger than the candidate set", () => {
  const items = [{ score: 0.2 }, { score: 0.4 }];
  assert.deepEqual(topK(items, 10).map((item) => item.score), [0.4, 0.2]);
  assert.deepEqual(topK([], 5), []);
});

test("topK agrees with a full sort on a larger random set", () => {
  const items = Array.from({ length: 500 }, () => ({ score: Math.random() }));
  const expected = [...items].sort((a, b) => b.score - a.score).slice(0, 8).map((i) => i.score);
  assert.deepEqual(topK(items, 8).map((i) => i.score), expected);
});

test("short text stays a single chunk", () => {
  assert.deepEqual(splitIntoChunks("Patient reports a mild headache."), [
    "Patient reports a mild headache.",
  ]);
  assert.deepEqual(splitIntoChunks(""), []);
  assert.deepEqual(splitIntoChunks("   "), []);
});

test("long text splits with overlap and loses no content", () => {
  const sentence = "The patient described intermittent chest discomfort on exertion. ";
  const text = sentence.repeat(80);
  const chunks = splitIntoChunks(text, { size: 400, overlap: 50 });
  assert.ok(chunks.length > 1, "expected several chunks");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 400, `chunk of ${chunk.length} exceeded the size limit`);
  }
  // Overlap means the join is longer than the source, but nothing may be dropped.
  const joined = chunks.join(" ").replace(/\s+/g, " ");
  assert.ok(joined.includes("intermittent chest discomfort"));
  assert.ok(joined.length >= text.trim().length);
});

test("splitting prefers paragraph and sentence boundaries", () => {
  const first = "A".repeat(300);
  const second = "B".repeat(300);
  const chunks = splitIntoChunks(`${first}\n\n${second}`, { size: 400, overlap: 20 });
  assert.ok(chunks[0].endsWith("A"), "first chunk should break at the blank line");
  assert.ok(!chunks[0].includes("B"), "first chunk should not run into the next paragraph");
});

test("chunking terminates on pathological input", () => {
  const chunks = splitIntoChunks("x".repeat(100000), { size: 200, overlap: 190 });
  assert.ok(chunks.length <= 40, "chunk count must stay bounded per source");
});
