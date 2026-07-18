export interface BatchOptions {
  concurrency?: number;
}

export async function runBatch<T, TResult>(
  inputs: readonly T[],
  execute: (input: T, index: number) => Promise<TResult>,
  options: BatchOptions = {}
): Promise<Array<{ index: number; input: T; status: "complete"; value: TResult } | { index: number; input: T; status: "failed"; error: Error }>> {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError("Batch concurrency must be an integer from 1 through 16.");
  }

  const results: Array<{ index: number; input: T; status: "complete"; value: TResult } | { index: number; input: T; status: "failed"; error: Error }> =
    new Array(inputs.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= inputs.length) {
        return;
      }
      const input = inputs[index]!;
      try {
        results[index] = { index, input, status: "complete", value: await execute(input, index) };
      } catch (error) {
        results[index] = { index, input, status: "failed", error: asError(error) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return results;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Batch generation failed.", { cause: error });
}
