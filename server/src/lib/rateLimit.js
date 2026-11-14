import { AppError } from "./errors.js";

// In-memory token bucket per client key. O(1) per request; idle buckets are
// swept so memory stays bounded by the number of recently active clients.
export class RateLimiter {
  constructor({ capacity, windowMs }) {
    this.capacity = capacity;
    this.refillPerMs = capacity / windowMs;
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs).unref();
  }

  take(key, cost = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refillPerMs);
      b.at = now;
    }
    if (b.tokens < cost) {
      return { ok: false, retryAfter: Math.ceil((cost - b.tokens) / this.refillPerMs / 1000) };
    }
    b.tokens -= cost;
    return { ok: true };
  }

  sweep() {
    const now = Date.now();
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }

  middleware() {
    return (req, res, next) => {
      const result = this.take(req.clientIp ?? req.ip);
      if (result.ok) return next();
      next(new AppError(429, "rate_limited", "Too many requests. Slow down a little.", { retryAfter: result.retryAfter }));
    };
  }

  close() {
    clearInterval(this.timer);
  }
}
