export interface UsageCost {
  amount: number;
  currency: string;
  estimated: boolean;
}

export interface UsageGenerationEvent {
  provider: string;
  model: string;
  cost: UsageCost;
  latencyMs: number;
  success: boolean;
  promptLength: number;
  timestamp: string;
  generationId?: string;
  errorCode?: string;
}

export interface UsageSummaryOptions {
  since?: Date | number | string;
  until?: Date | number | string;
}

export interface UsageCostSummary {
  currency: string;
  amount: number;
  actualAmount: number;
  estimatedAmount: number;
}

export interface UsageProviderSummary {
  provider: string;
  generations: number;
  successes: number;
  failures: number;
  successRate: number;
  averageLatencyMs: number;
  costs: UsageCostSummary[];
}

export interface UsageSummary {
  generations: number;
  successes: number;
  failures: number;
  successRate: number;
  averageLatencyMs: number;
  costs: UsageCostSummary[];
  providers: UsageProviderSummary[];
}

export type UsageListener = (event: Readonly<UsageGenerationEvent>) => void;

export interface InMemoryUsageTrackerOptions {
  now?: () => number;
}

/**
 * Dependency-free storage for terminal provider-attempt events. It intentionally
 * records attempts rather than only final jobs, so fallback spending remains
 * visible once the client integrates it in Phase 5.
 */
export class InMemoryUsageTracker {
  private readonly events: UsageGenerationEvent[] = [];
  private readonly listeners = new Set<UsageListener>();
  private readonly now: () => number;

  constructor(options: InMemoryUsageTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  record(event: UsageGenerationEvent): Readonly<UsageGenerationEvent> {
    const normalized = normalizeUsageEvent(event);
    this.events.push(normalized);

    const snapshot = freezeEvent(normalized);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers must not alter image-generation behavior.
      }
    }

    return snapshot;
  }

  on(listener: UsageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary(options: UsageSummaryOptions = {}): UsageSummary {
    const { since, until } = normalizeRange(options, this.now);
    const events = this.events.filter((event) => {
      const timestamp = Date.parse(event.timestamp);
      return timestamp >= since && timestamp <= until;
    });

    return summarize(events);
  }

  snapshot(): readonly Readonly<UsageGenerationEvent>[] {
    return this.events.map(freezeEvent);
  }

  clear(): void {
    this.events.length = 0;
  }
}

function normalizeUsageEvent(event: UsageGenerationEvent): UsageGenerationEvent {
  const provider = requiredText(event.provider, "event.provider");
  const model = requiredText(event.model, "event.model");
  const currency = requiredText(event.cost?.currency, "event.cost.currency").toUpperCase();
  const amount = nonNegativeFinite(event.cost?.amount, "event.cost.amount");
  const latencyMs = nonNegativeFinite(event.latencyMs, "event.latencyMs");

  if (!Number.isInteger(event.promptLength) || event.promptLength < 0) {
    throw new RangeError("event.promptLength must be a non-negative integer.");
  }

  if (typeof event.success !== "boolean" || typeof event.cost?.estimated !== "boolean") {
    throw new TypeError("event.success and event.cost.estimated must be boolean values.");
  }

  const timestamp = new Date(event.timestamp).toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new RangeError("event.timestamp must be a valid date string.");
  }

  return {
    provider,
    model,
    cost: { amount, currency, estimated: event.cost.estimated },
    latencyMs,
    success: event.success,
    promptLength: event.promptLength,
    timestamp,
    ...(event.generationId === undefined ? {} : { generationId: requiredText(event.generationId, "event.generationId") }),
    ...(event.errorCode === undefined ? {} : { errorCode: requiredText(event.errorCode, "event.errorCode") })
  };
}

function normalizeRange(options: UsageSummaryOptions, now: () => number): { since: number; until: number } {
  const current = now();
  const since = normalizeBoundary(options.since, 0, current);
  const until = normalizeBoundary(options.until, current, current);

  if (since > until) {
    throw new RangeError("usage.summary() requires since to be before or equal to until.");
  }

  return { since, until };
}

function normalizeBoundary(value: Date | number | string | undefined, defaultValue: number, now: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("Usage time boundaries must be finite timestamps.");
    }

    return value;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isNaN(timestamp)) {
      throw new RangeError("Usage time boundaries must be valid dates.");
    }

    return timestamp;
  }

  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (duration) {
    const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as "ms" | "s" | "m" | "h" | "d"];
    return now - Number(duration[1]) * multiplier;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new RangeError("Usage time boundaries must be timestamps, dates, or durations such as \"24h\".");
  }

  return timestamp;
}

function summarize(events: readonly UsageGenerationEvent[]): UsageSummary {
  const overall = createAccumulator();
  const byProvider = new Map<string, Accumulator>();

  for (const event of events) {
    addEvent(overall, event);
    const provider = byProvider.get(event.provider) ?? createAccumulator();
    addEvent(provider, event);
    byProvider.set(event.provider, provider);
  }

  return {
    ...toSummaryBase(overall),
    providers: [...byProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, accumulator]) => ({ provider, ...toSummaryBase(accumulator) }))
  };
}

interface Accumulator {
  generations: number;
  successes: number;
  latencyMs: number;
  costs: Map<string, { amount: number; actualAmount: number; estimatedAmount: number }>;
}

function createAccumulator(): Accumulator {
  return { generations: 0, successes: 0, latencyMs: 0, costs: new Map() };
}

function addEvent(accumulator: Accumulator, event: UsageGenerationEvent): void {
  accumulator.generations += 1;
  accumulator.successes += event.success ? 1 : 0;
  accumulator.latencyMs += event.latencyMs;

  const cost = accumulator.costs.get(event.cost.currency) ?? { amount: 0, actualAmount: 0, estimatedAmount: 0 };
  cost.amount += event.cost.amount;
  if (event.cost.estimated) {
    cost.estimatedAmount += event.cost.amount;
  } else {
    cost.actualAmount += event.cost.amount;
  }
  accumulator.costs.set(event.cost.currency, cost);
}

function toSummaryBase(accumulator: Accumulator): Omit<UsageProviderSummary, "provider"> {
  const generations = accumulator.generations;
  const successes = accumulator.successes;

  return {
    generations,
    successes,
    failures: generations - successes,
    successRate: generations === 0 ? 0 : successes / generations,
    averageLatencyMs: generations === 0 ? 0 : accumulator.latencyMs / generations,
    costs: [...accumulator.costs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, cost]) => ({ currency, ...cost }))
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }

  return value;
}

function freezeEvent(event: UsageGenerationEvent): Readonly<UsageGenerationEvent> {
  return Object.freeze({
    ...event,
    cost: Object.freeze({ ...event.cost })
  });
}
