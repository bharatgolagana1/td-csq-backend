// A small deterministic PRNG (mulberry32 seeded from a string) so the demo
// dataset is the same on every machine and every re-run. Every independent
// part of the dataset forks its own stream from a stable key, so adding an
// operator or a customer later never reshuffles the rest.

function hashSeed(key: string): number {
  // FNV-1a over the UTF-16 code units; good enough to spread similar keys.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class Rng {
  private state: number;

  constructor(private readonly key: string) {
    this.state = hashSeed(key) || 0x9e3779b9;
  }

  /** A new independent stream for a sub-part of the dataset. */
  fork(suffix: string): Rng {
    return new Rng(`${this.key}/${suffix}`);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Picks an index according to relative weights. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
    let roll = this.next() * total;
    for (const [index, weight] of weights.entries()) {
      roll -= Math.max(0, weight);
      if (roll < 0) return index;
    }
    return weights.length - 1;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** `count` distinct items, in a stable random order. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, Math.min(count, items.length)));
  }
}
