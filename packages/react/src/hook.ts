import type { ImageClient, ImageGenerationInput, ImageResult, Job, JobStatus } from "@image-sdk/core";

export type ImageGenerationHookStatus = "idle" | JobStatus;

export interface ImageGenerationState {
  status: ImageGenerationHookStatus;
  progress?: number;
  job?: Job;
  result?: ImageResult;
  error?: Error;
}

export interface UseImageGenerationResult extends ImageGenerationState {
  generate(input: ImageGenerationInput): Promise<ImageResult>;
  cancel(): Promise<void>;
  reset(): void;
}

export interface ReactHookRuntime {
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void;
  useRef<T>(initialValue: T): { current: T };
  useState<T>(initialValue: T): [T, (value: T | ((previous: T) => T)) => void];
}

const idleState: ImageGenerationState = { status: "idle" };

/**
 * Creates a React hook from a React-compatible hooks runtime. The factory keeps
 * the state machine independently testable and lets React remain a peer dependency.
 */
export function createUseImageGeneration(runtime: ReactHookRuntime) {
  return function useImageGeneration(client: ImageClient): UseImageGenerationResult {
    const [state, setState] = runtime.useState<ImageGenerationState>(idleState);
    const currentJob = runtime.useRef<Job | undefined>(undefined);
    const requestVersion = runtime.useRef(0);
    const mounted = runtime.useRef(true);

    runtime.useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        requestVersion.current += 1;
      };
    }, []);

    const update = (version: number, next: ImageGenerationState | ((previous: ImageGenerationState) => ImageGenerationState)) => {
      if (!mounted.current || requestVersion.current !== version) {
        return;
      }

      setState(next);
    };

    return {
      ...state,
      async generate(input: ImageGenerationInput): Promise<ImageResult> {
        const version = requestVersion.current + 1;
        requestVersion.current = version;
        currentJob.current = undefined;
        update(version, { status: "queued" });

        try {
          const job = await client.generate(input);
          currentJob.current = job;
          update(version, { status: job.status, job, progress: job.progress });

          job.on("progress", (progress) => {
            update(version, (previous) => ({ ...previous, status: job.status, progress }));
          });

          const result = await job.result();
          update(version, { status: "complete", job, progress: job.progress, result });
          return result;
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error("Image generation failed.");
          update(version, (previous) => ({ ...previous, status: "failed", error: normalized }));
          throw normalized;
        }
      },
      async cancel(): Promise<void> {
        const job = currentJob.current;

        if (!job) {
          return;
        }

        const version = requestVersion.current;
        await job.cancel();
        update(version, (previous) => ({ ...previous, status: job.status, error: previous.error }));
      },
      reset(): void {
        requestVersion.current += 1;
        currentJob.current = undefined;
        if (mounted.current) {
          setState(idleState);
        }
      }
    };
  };
}
