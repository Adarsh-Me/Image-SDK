import { Job, type AdapterJobHandle, type ImageClient, type ImageGenerationInput, type ImageResult } from "@image-sdk/core";
import { describe, expect, it } from "vitest";
import { createUseImageGeneration, type ReactHookRuntime } from "../src/hook";

const result: ImageResult = {
  url: "https://example.test/image.png",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  provider: "test",
  model: "test-model",
  cost: { amount: 0, currency: "USD", estimated: true },
  moderation: { flagged: false, provider: "test" }
};

class HookHarness {
  private slots: unknown[] = [];
  private cursor = 0;
  private effects: Array<() => void | (() => void)> = [];
  private cleanups: Array<() => void> = [];

  readonly runtime: ReactHookRuntime = {
    useState: <T>(initialValue: T) => {
      const index = this.cursor++;
      if (!(index in this.slots)) {
        this.slots[index] = initialValue;
      }
      const set = (value: T | ((previous: T) => T)) => {
        const previous = this.slots[index] as T;
        this.slots[index] = typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
      };
      return [this.slots[index] as T, set];
    },
    useRef: <T>(initialValue: T) => {
      const index = this.cursor++;
      if (!(index in this.slots)) {
        this.slots[index] = { current: initialValue };
      }
      return this.slots[index] as { current: T };
    },
    useEffect: (effect) => {
      this.effects.push(effect);
    }
  };

  render<T>(render: () => T): T {
    this.cursor = 0;
    const value = render();
    const effects = this.effects.splice(0);
    for (const effect of effects) {
      const cleanup = effect();
      if (cleanup) {
        this.cleanups.push(cleanup);
      }
    }
    return value;
  }

  unmount(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
  }
}

function clientFor(handle: AdapterJobHandle): ImageClient {
  return {
    generate: async (_input: ImageGenerationInput) => new Job(handle),
    job: async () => new Job(handle),
    parseWebhook: async () => result,
    capabilities: (async () => ({})) as ImageClient["capabilities"]
  };
}

describe("createUseImageGeneration", () => {
  it("tracks progress and the completed result without a browser", async () => {
    let progressListener: ((value: number) => void) | undefined;
    const handle: AdapterJobHandle = {
      id: "job-1",
      provider: "test",
      onProgress(listener) {
        progressListener = listener;
      },
      async result() {
        progressListener?.(0.5);
        return result;
      }
    };
    const harness = new HookHarness();
    const useImageGeneration = createUseImageGeneration(harness.runtime);
    let hook = harness.render(() => useImageGeneration(clientFor(handle)));

    await hook.generate({ prompt: "clouds" });
    hook = harness.render(() => useImageGeneration(clientFor(handle)));

    expect(hook.status).toBe("complete");
    expect(hook.progress).toBe(0.5);
    expect(hook.result).toEqual(result);
    expect(hook.error).toBeUndefined();
  });

  it("surfaces failures and supports cancellation", async () => {
    let cancelled = false;
    const failure = new Error("provider failed");
    const handle: AdapterJobHandle = {
      id: "job-2",
      provider: "test",
      async result() {
        throw failure;
      },
      async cancel() {
        cancelled = true;
      }
    };
    const harness = new HookHarness();
    const useImageGeneration = createUseImageGeneration(harness.runtime);
    let hook = harness.render(() => useImageGeneration(clientFor(handle)));

    await expect(hook.generate({ prompt: "clouds" })).rejects.toThrow("provider failed");
    hook = harness.render(() => useImageGeneration(clientFor(handle)));
    expect(hook.status).toBe("failed");
    expect(hook.error).toBe(failure);

    await hook.cancel();
    expect(cancelled).toBe(true);
  });

  it("does not update state after unmount", async () => {
    let resolveResult: ((value: ImageResult) => void) | undefined;
    const handle: AdapterJobHandle = {
      id: "job-3",
      provider: "test",
      result: () => new Promise<ImageResult>((resolve) => {
        resolveResult = resolve;
      })
    };
    const harness = new HookHarness();
    const useImageGeneration = createUseImageGeneration(harness.runtime);
    const hook = harness.render(() => useImageGeneration(clientFor(handle)));
    const pending = hook.generate({ prompt: "clouds" });

    await Promise.resolve();
    harness.unmount();
    resolveResult?.(result);
    await pending;
    const afterUnmount = harness.render(() => useImageGeneration(clientFor(handle)));

    expect(afterUnmount.status).not.toBe("complete");
  });
});
