/** Shared token bucket pacing translation requests (units/min).
 *  The dispatcher is a single process, so one module-level bucket
 *  correctly paces every concurrent translate job. */

let capacity = 1;
let tokens = 1;
let refillPerSec = 30 / 60;
let lastRefill = Date.now();

export function setRate(unitsPerMin: number): void {
  const rpm = Math.max(1, Math.min(600, Math.round(unitsPerMin)));
  capacity = rpm;
  refillPerSec = rpm / 60;
  if (tokens > capacity) tokens = capacity;
}

function refill(): void {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  if (elapsed <= 0) return;
  tokens = Math.min(capacity, tokens + elapsed * refillPerSec);
  lastRefill = now;
}

/** Wait until `n` tokens are available, then consume them. */
export async function acquire(n = 1): Promise<void> {
  for (;;) {
    refill();
    if (tokens >= n) {
      tokens -= n;
      return;
    }
    const deficit = n - tokens;
    await new Promise((r) => setTimeout(r, (deficit / refillPerSec) * 1000));
  }
}
