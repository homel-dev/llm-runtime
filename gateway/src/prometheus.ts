export type MetricLabels = Record<string, string>;

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels).sort().map((key) => `${key}\u0000${labels[key] ?? ""}`).join("\u0001");
}

function renderLabels(labels: MetricLabels, extra?: [string, string]): string {
  const entries = Object.entries(labels);
  if (extra) entries.push(extra);
  if (!entries.length) return "";
  entries.sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

interface MetricSample {
  labels: MetricLabels;
  value: number;
}

export class CounterVec {
  readonly name: string;
  readonly help: string;
  private readonly samples = new Map<string, MetricSample>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: MetricLabels, delta = 1): void {
    if (!Number.isFinite(delta) || delta < 0) throw new Error(`counter ${this.name} delta must be non-negative`);
    const key = labelKey(labels);
    const current = this.samples.get(key);
    if (current) current.value += delta;
    else this.samples.set(key, { labels: { ...labels }, value: delta });
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const sample of this.samples.values()) out.push(`${this.name}${renderLabels(sample.labels)} ${sample.value}`);
    return out;
  }
}

export class GaugeVec {
  readonly name: string;
  readonly help: string;
  private readonly samples = new Map<string, MetricSample>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value)) throw new Error(`gauge ${this.name} value must be finite`);
    this.samples.set(labelKey(labels), { labels: { ...labels }, value });
  }

  inc(labels: MetricLabels, delta = 1): void {
    const key = labelKey(labels);
    const current = this.samples.get(key);
    this.set(labels, (current?.value ?? 0) + delta);
  }

  dec(labels: MetricLabels, delta = 1): void { this.inc(labels, -delta); }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const sample of this.samples.values()) out.push(`${this.name}${renderLabels(sample.labels)} ${sample.value}`);
    return out;
  }
}

interface HistogramSample {
  labels: MetricLabels;
  bucketCounts: number[];
  count: number;
  sum: number;
}

export class HistogramVec {
  readonly name: string;
  readonly help: string;
  private readonly buckets: number[];
  private readonly samples = new Map<string, HistogramSample>();

  constructor(name: string, help: string, buckets: number[]) {
    if (!buckets.length || buckets.some((bucket) => !Number.isFinite(bucket) || bucket <= 0)) throw new Error(`histogram ${name} requires positive finite buckets`);
    this.name = name;
    this.help = help;
    this.buckets = [...new Set(buckets)].sort((a, b) => a - b);
  }

  observe(labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new Error(`histogram ${this.name} value must be non-negative`);
    const key = labelKey(labels);
    let sample = this.samples.get(key);
    if (!sample) {
      sample = { labels: { ...labels }, bucketCounts: this.buckets.map(() => 0), count: 0, sum: 0 };
      this.samples.set(key, sample);
    }
    sample.count += 1;
    sample.sum += value;
    for (let i = 0; i < this.buckets.length; i += 1) if (value <= this.buckets[i]!) sample.bucketCounts[i]! += 1;
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const sample of this.samples.values()) {
      for (let i = 0; i < this.buckets.length; i += 1) {
        out.push(`${this.name}_bucket${renderLabels(sample.labels, ["le", String(this.buckets[i])])} ${sample.bucketCounts[i]}`);
      }
      out.push(`${this.name}_bucket${renderLabels(sample.labels, ["le", "+Inf"])} ${sample.count}`);
      out.push(`${this.name}_sum${renderLabels(sample.labels)} ${sample.sum}`);
      out.push(`${this.name}_count${renderLabels(sample.labels)} ${sample.count}`);
    }
    return out;
  }
}

export interface PrometheusMetric {
  render(): string[];
}

export function renderPrometheus(metrics: PrometheusMetric[]): string {
  return `${metrics.flatMap((metric) => metric.render()).join("\n")}\n`;
}
