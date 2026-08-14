// Read token usage out of a DSH headless session log (.jsonl.zstd).
// Splits concatenated Zstandard frames on the magic number, decompresses each
// frame with node:zlib, then scans the JSON lines for usage fields.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const frames = []
let start = -1
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
    if (start >= 0) frames.push(buf.subarray(start, i))
    start = i
  }
}
if (start >= 0) frames.push(buf.subarray(start))

let text = ''
let failed = 0
for (const f of frames) {
  try {
    text += zstdDecompressSync(f).toString('utf8')
  } catch {
    failed++
  }
}
console.log('frames:', frames.length, '| failed:', failed, '| text chars:', text.length)
const lines = text.split('\n').filter(Boolean)
console.log('json lines:', lines.length)

const keys = ['cacheRead', 'cacheWrite', 'uncachedInput', 'outputTokens', 'inputTokens', 'completionTokens', '"usage"']
for (const k of keys) {
  const n = lines.filter(l => l.includes(k)).length
  console.log('lines containing', k, '=>', n)
}
const hits = lines.filter(l => /usage|oken/i.test(l))
console.log('--- last 2 usage-ish lines (truncated) ---')
for (const h of hits.slice(-2)) console.log(h.slice(0, 300))

// Sum the disjoint usage buckets across every model request.
const totals = { input: 0, cacheRead: 0, output: 0, reasoning: 0 }
let requests = 0
let model = null
for (const line of lines) {
  let j
  try { j = JSON.parse(line) } catch { continue }
  // Only assistant/message carries the step's final usage; assistant/chunk
  // repeats the same numbers, so counting both would double the totals.
  const u = j && j.type === 'assistant/message' && j.data ? j.data.usage : null
  if (!u || typeof u.inputTokens !== 'number') continue
  totals.input += u.inputTokens
  totals.cacheRead += u.cacheReadTokens || 0
  totals.output += u.outputTokens || 0
  totals.reasoning += u.reasoningTokens || 0
  requests++
  if (!model) {
    const m = j.data && j.data.message && j.data.message.source && j.data.message.source.model
    if (m) model = m
  }
}
console.log('=== TOTALS ===')
console.log('model:', model)
console.log('model requests:', requests)
console.log('uncached input:', totals.input)
console.log('cached read:', totals.cacheRead)
console.log('output:', totals.output)
console.log('reasoning:', totals.reasoning)

// Duration from the first to the last logged event time (ms epoch).
let tMin = Infinity
let tMax = -Infinity
for (const line of lines) {
  let j
  try { j = JSON.parse(line) } catch { continue }
  if (typeof j.time === 'number') {
    if (j.time < tMin) tMin = j.time
    if (j.time > tMax) tMax = j.time
  }
}
if (tMax > 0 && tMin < Infinity) {
  console.log('event-span (s):', ((tMax - tMin) / 1000).toFixed(1))
}
