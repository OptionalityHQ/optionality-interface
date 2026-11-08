/**
 * A rolling record of this session, for the screen's own chart.
 *
 * The gateway is the only place that sees the index and a marked position on the
 * same read, so it is the only place that can draw the two over time. What it
 * keeps is deliberately small and deliberately labelled: one sample a second, a
 * few minutes deep, gone when the process is. Calling that "history" would be a
 * lie the page then repeats, so the payload says how long it spans and how often
 * it was sampled, and the chart prints it.
 */
export interface Sample {
  atMs: number;
  /** The index the read saw, in dollars. */
  spot: number | null;
  /** What the open tickets were worth against their cost, at what a close pays. */
  open: number | null;
  /** How many seats of the settlement committee agreed on this read. */
  agreeing: number | null;
  /** The price the committee last fixed, in dollars. */
  fix: number | null;
}

export interface SessionHistory {
  points: Sample[];
  /** Seconds between the first and last sample. */
  spanS: number;
  /** Seconds between samples, so a reader can tell a flat line from a gap. */
  sampledEveryS: number;
}

export class History {
  /**
   * One series per asset, never one for the venue: the index line of a BTC chart
   * drawn from ETH samples is not a quiet bug, it is a chart that jumps between
   * 77,000 and 2,200 and a PnL line measured against it.
   */
  private byAsset = new Map<string, Sample[]>();
  private readonly capacity: number;
  private readonly everyMs: number;

  constructor(capacity = 300, everyMs = 1_000) {
    this.capacity = capacity;
    this.everyMs = everyMs;
  }

  private samples(asset: string): Sample[] {
    let samples = this.byAsset.get(asset);
    if (!samples) {
      samples = [];
      this.byAsset.set(asset, samples);
    }
    return samples;
  }

  /**
   * Record a read into the second it belongs to.
   *
   * Two reads in the same interval update one point rather than adding two: the
   * chart's right edge is then always the last thing the gateway saw, while the
   * body of the series stays evenly spaced. Measuring from the *last append* would
   * have kept sliding the head forward, and a poll faster than the interval would
   * never have grown the series at all.
   */
  push(asset: string, sample: Sample): void {
    const samples = this.samples(asset);
    const last = samples[samples.length - 1];
    const bucket = (atMs: number) => Math.floor(atMs / this.everyMs);
    if (last && bucket(sample.atMs) === bucket(last.atMs)) {
      samples[samples.length - 1] = sample;
      return;
    }
    samples.push(sample);
    if (samples.length > this.capacity) {
      samples.splice(0, samples.length - this.capacity);
    }
  }

  series(asset: string): SessionHistory {
    const points = this.samples(asset).slice();
    const spanS =
      points.length > 1 ? (points[points.length - 1].atMs - points[0].atMs) / 1000 : 0;
    return { points, spanS, sampledEveryS: this.everyMs / 1000 };
  }

  get length(): number {
    let total = 0;
    for (const samples of this.byAsset.values()) total += samples.length;
    return total;
  }
}
