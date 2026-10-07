import crypto from 'node:crypto'

const rateBuckets = new Map()

export function tokensMatch(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false
  const a = Buffer.from(expected), b = Buffer.from(actual)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function allowRate(ip, bucket, limit, windowMs) {
  const key = `${ip}:${bucket}`
  let item = rateBuckets.get(key)
  if (!item || Date.now() - item.startedAt >= windowMs) {
    item = { startedAt: Date.now(), count: 0 }
    rateBuckets.set(key, item)
  }
  item.count++
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (Date.now() - v.startedAt >= windowMs) rateBuckets.delete(k)
  }
  return item.count <= limit
}
