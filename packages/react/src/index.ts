import { useEffect, useRef, useState } from "react";

export { createUseImageGeneration } from "./hook";
export type { ImageGenerationHookStatus, ImageGenerationState, ReactHookRuntime, UseImageGenerationResult } from "./hook";

/** Tracks an image job's lifecycle for the supplied ImageClient. */
export const useImageGeneration = createUseImageGeneration({ useEffect, useRef, useState });

import { createUseImageGeneration } from "./hook";
