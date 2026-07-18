import { CancellationError, ProviderError } from "./errors";
import type { AdapterJobHandle, ImageResult, JobEvent, JobEventData, JobStatus } from "./types";

type Listener = (data: unknown) => void;

export class Job {
  readonly id: string;
  readonly provider: string;
  status: JobStatus;
  progress?: number;

  private readonly handle: AdapterJobHandle;
  private readonly listeners = new Map<JobEvent, Set<Listener>>();
  private resultPromise?: Promise<ImageResult>;
  private cancelled = false;

  constructor(handle: AdapterJobHandle) {
    this.handle = handle;
    this.id = handle.id;
    this.provider = handle.provider;
    this.status = handle.status ?? "queued";

    handle.onProgress?.((progress) => {
      if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
        return;
      }

      this.progress = progress;
      this.emit("progress", progress);
    });
  }

  on<TEvent extends JobEvent>(event: TEvent, callback: (data: JobEventData[TEvent]) => void): void {
    const existing = this.listeners.get(event) ?? new Set<Listener>();
    existing.add(callback as Listener);
    this.listeners.set(event, existing);
  }

  result(): Promise<ImageResult> {
    if (this.cancelled) {
      return Promise.reject(new CancellationError());
    }

    if (!this.resultPromise) {
      if (this.status !== "complete") {
        this.status = "running";
      }

      this.resultPromise = this.handle
        .result()
        .then((result) => {
          if (this.cancelled) {
            throw new CancellationError();
          }

          this.status = "complete";
          this.emit("complete", result);
          return result;
        })
        .catch((error: unknown) => {
          const normalizedError =
            error instanceof Error
              ? error
              : new ProviderError(this.provider, "The provider returned an unknown image generation error.", undefined, error);

          this.status = "failed";
          this.emit("error", normalizedError);
          throw normalizedError;
        });
    }

    return this.resultPromise;
  }

  async cancel(): Promise<void> {
    if (this.status === "complete") {
      return;
    }

    if (!this.handle.cancel) {
      throw new CancellationError(`${this.provider} does not support cancelling this generation.`);
    }

    await this.handle.cancel();
    this.cancelled = true;
    this.status = "failed";
    this.emit("error", new CancellationError());
  }

  private emit<TEvent extends JobEvent>(event: TEvent, payload: JobEventData[TEvent]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch {
        // User event handlers must not alter the job lifecycle.
      }
    }
  }
}
