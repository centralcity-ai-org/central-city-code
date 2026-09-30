/** Exact-sample latency recorder. Load runs here are small enough to keep every sample. */
export class Samples {
  private values = new Float64Array(1024);
  private length = 0;
  private sorted = true;
  add(value: number): void {
    if (this.length === this.values.length) {
      const grown = new Float64Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    if (this.length && value < this.values[this.length - 1]!) this.sorted = false;
    this.values[this.length++] = value;
  }
  get count(): number {
    return this.length;
  }
  private view(): Float64Array {
    const view = this.values.subarray(0, this.length);
    if (!this.sorted) {
      view.sort();
      this.sorted = true;
    }
    return view;
  }
  percentile(p: number): number {
    if (!this.length) return 0;
    const view = this.view();
    const index = Math.min(this.length - 1, Math.max(0, Math.ceil((p / 100) * this.length) - 1));
    return view[index]!;
  }
  max(): number {
    return this.length ? this.view()[this.length - 1]! : 0;
  }
  mean(): number {
    let sum = 0;
    for (let index = 0; index < this.length; index++) sum += this.values[index]!;
    return this.length ? sum / this.length : 0;
  }
  summary(): LatencySummary {
    return {
      count: this.length,
      p50: round(this.percentile(50)),
      p95: round(this.percentile(95)),
      p99: round(this.percentile(99)),
      max: round(this.max()),
      mean: round(this.mean()),
    };
  }
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export const round = (value: number, digits = 2) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
