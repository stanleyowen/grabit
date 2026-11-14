import { AppError } from "./errors.js";

// Counting semaphore with a bounded wait queue (backpressure instead of
// unbounded memory growth when traffic spikes).
export class Semaphore {
  constructor(limit, maxQueue) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.waiters = [];
  }

  async run(fn) {
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.maxQueue) {
        throw new AppError(503, "busy", "The server is busy. Try again in a moment.", { retryAfter: 10 });
      }
      await new Promise((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next(); // hand the slot over directly
      else this.active -= 1;
    }
  }

  get pending() {
    return this.waiters.length;
  }
}
