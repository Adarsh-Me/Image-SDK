<h1 align="center">image-sdk</h1>

<p align="center">
  <img src="./banner.png" alt="Image SDK Banner" width="100%" />
</p>

<p align="center"><strong>The unified TypeScript client for AI image generation.</strong></p>

<p align="center">
  One line to your first image. Full production control when you need it.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@image-sdk/sdk"><img src="https://img.shields.io/npm/v/@image-sdk/sdk.svg" alt="npm version"></a>
  <a href="https://github.com/Adarsh-Me/Image-SDK/stargazers"><img src="https://img.shields.io/github/stars/Adarsh-Me/Image-SDK.svg" alt="GitHub stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0 license"></a>
  <img src="https://img.shields.io/badge/status-early%20access%20(v0.1)-orange.svg" alt="Status: early access">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#why-image-sdk">Why image-sdk</a> ·
  <a href="#advanced-usage">Advanced usage</a> ·
  <a href="#providers">Providers</a> ·
  <a href="#project-status">Project status</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## Why image-sdk

Every AI image provider — Flux, Ideogram, Recraft, OpenAI, Stability, Google Imagen — ships its own
request shape, its own way of reporting completion, and its own way of failing. Most are asynchronous
under the hood: you submit a request and poll for a result, and on a serverless platform that polling
can burn your function's execution budget or hit a gateway timeout before the image is even ready.

Generic multi-provider SDKs (including the image support built into larger frameworks) solve the easy
80% of this — swap a provider by changing a string — and leave the operationally hard 20% to you:

| Problem | What usually happens without `image-sdk` |
|---|---|
| Async lifecycle differs per provider | You hand-roll polling logic per adapter, and it breaks the first time you deploy to serverless |
| Provider result URLs expire | You store the URL, ship it, and find out it's broken when a user reports it |
| Moderation responses aren't normalized | You write provider-specific handling for something that should be a single, predictable check |
| No cross-provider fallback | A single provider outage becomes a user-facing outage |
| No cost visibility | You find out what you spent by checking your invoice at the end of the month |
| Every SDK assumes intermediate knowledge | A beginner has to learn "adapters" and "async jobs" before generating a single image |

`image-sdk` is built around one architectural rule: **the beginner API and the production API are the
same client.** `generateImage()` is a thin wrapper over the exact same engine that powers fallback,
cost tracking, and serverless-safe job handling — so growing from a prototype into a production
integration never means switching tools or rewriting your generation logic.

---

## What you get

- **One line to your first image** — `generateImage("a cat")`, no client to configure
- **Zero-setup demo mode** — try it from your terminal with no API key and no signup
- Adapters for **Flux, Ideogram, Recraft, OpenAI, Google Imagen, Stability, Replicate, and fal.ai**
- One normalized async lifecycle across every provider, sync or poll-based or webhook-based
- Serverless-safe job handling — trigger in one request, resume and read the result in another
- Normalized moderation results across every adapter
- Automatic fallback and retry across providers
- Built-in cost and usage tracking, no external tooling required
- Pluggable permanent storage (S3/R2) so expiring provider URLs don't silently break in production
- An isolated `mock` adapter for tests and CI — no network calls, no cost
- A CLI, a React hook, and an MCP server for agent-native workflows (Claude Code, Cursor)

---

## Install

```bash
npm install @image-sdk/sdk
```

> **Naming note:** the unscoped name `image-sdk` was blocked by npm's automated name-similarity check
> against an existing package. The published SDK lives at the scoped name `@image-sdk/sdk` — everything
> you `import` comes from this one package.

Requires Node 20+ or Bun, server-side or edge runtime. Keep provider API keys out of browser code.

---

## Quickstart

### 1. Try it — no install, no signup, no API key

```bash
npx --package=@image-sdk/cli image-sdk try "a cat wearing sunglasses"
```

Calls a free, keyless demo image service and saves the result locally. For evaluation only — not
production traffic.

### 2. Use it in code

```ts
import { generateImage } from "@image-sdk/sdk";

const image = await generateImage("a cat wearing sunglasses");
console.log(image.url);
```

No client to set up, no provider to choose. This is the entire integration.

### 3. Connect a real provider

`generateImage()` auto-detects credentials from environment variables — configure any one to start:

| Provider | Env var | Get a key |
|---|---|---|
| Flux (Black Forest Labs) | `BFL_API_KEY` | https://bfl.ai |
| Ideogram | `IDEOGRAM_API_KEY` | https://ideogram.ai/api |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com |
| Stability AI | `STABILITY_API_KEY` | https://platform.stability.ai |
| Recraft | `RECRAFT_API_KEY` | https://recraft.ai |
| Replicate | `REPLICATE_API_TOKEN` | https://replicate.com |
| fal.ai | `FAL_KEY` | https://fal.ai |
| Google Imagen | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | https://ai.google.dev |

```bash
BFL_API_KEY=your-key-here
```

Re-run the same code from step 2 — no changes required, `image-sdk` picks up whichever adapters it
finds configured.

**That covers onboarding end-to-end. Everything below is optional depth.**

---

## Common options

```ts
const image = await generateImage("a cyberpunk skyline", {
  aspectRatio: "16:9",   // "1:1" | "16:9" | "9:16" | "4:3" | custom "W:H"
  quality: "high",       // "draft" | "standard" | "high"
  seed: 42,
});
```

## Editing an existing image

```ts
import { editImage } from "@image-sdk/sdk";
import fs from "node:fs";

const image = await editImage("add a neon cat sitting on the couch", {
  image: fs.readFileSync("./living-room.png"),
});
```

Input format (buffer, URL, base64) is normalized per adapter automatically.

---

## Advanced usage

Full control when you need it — same underlying client as the Quickstart above.

### Multiple providers with fallback

```ts
import { createImageClient } from "@image-sdk/core";
import { flux } from "@image-sdk/flux";
import { ideogram } from "@image-sdk/ideogram";

const images = createImageClient({
  adapters: [
    flux({ apiKey: process.env.BFL_API_KEY! }),
    ideogram({ apiKey: process.env.IDEOGRAM_API_KEY! }),
  ],
  fallback: true,
});

const job = await images.generate({ prompt: "a minimalist logo, navy and gold" });
const result = await job.result();
```

### The job model, and safe usage on serverless

```ts
const job = await images.generate({ prompt: "..." });
job.on("progress", (p) => console.log(`${p * 100}% done`));
const result = await job.result();
```

On Vercel functions or Cloudflare Workers, don't hold a function open for a slow provider — split
trigger from resume:

```ts
// Route A — fires the request, persists a reference, returns immediately
const job = await images.generate({ prompt: "...", strategy: "async" });
await db.saveImageJob({ id: job.id, provider: job.provider });

// Route B — a webhook, cron, or later request — resumes the same job
const job = images.job(jobId, { provider: "flux" });
const result = await job.result();
```

### Permanent storage for expiring provider URLs

Flux, for example, returns result links that expire in 10 minutes. Configure storage pass-through to
avoid shipping a link that will silently break:

```ts
import { s3Storage } from "@image-sdk/storage-s3";

const images = createImageClient({
  adapters: [...],
  storage: s3Storage({ bucket: "my-assets", publicUrlPrefix: "https://cdn.myapp.com/" }),
});
```

### Cost visibility and spend limits

```ts
images.on("generation", (event) => console.log(event.provider, event.cost, event.latencyMs));
const summary = await images.usage.summary({ since: "24h" });
```

```ts
const images = createImageClient({
  adapters: [...],
  limits: { maxCostPerCall: 0.10, maxSpendPerDay: 5.00 },
});
```

### Testing without network calls

```ts
import { mock } from "@image-sdk/mock";
const images = createImageClient({ adapters: [mock()] });
```

### Capability introspection

```ts
const caps = images.capabilities("recraft");
```

---

## Providers

| Provider | Native delivery | Strengths | Package |
|---|---|---|---|
| Flux (Black Forest Labs) | Async, poll-based — result expires in 10 min | Photorealism | `@image-sdk/flux` |
| Ideogram | Async | Text-in-image accuracy | `@image-sdk/ideogram` |
| Recraft | Sync | Vector/SVG, brand assets | `@image-sdk/recraft` |
| OpenAI (GPT Image) | Sync | General purpose | `@image-sdk/openai` |
| Google Imagen | Async | Multi-image fusion | `@image-sdk/google` |
| Stability AI | Async + webhook | Self-hosted/VPC option | `@image-sdk/stability` |
| Replicate | Async | Long tail of open models | `@image-sdk/replicate` |
| fal.ai | Async | Speed/pricing | `@image-sdk/fal` |
| Mock | — | Testing/CI, zero network calls | `@image-sdk/mock` |

The table describes native provider behavior for infrastructure planning purposes — `image-sdk`
normalizes all of it to the same interface regardless.

---

## Monorepo packages

| Package | Purpose |
|---|---|
| `@image-sdk/core` | Client, `Job` model, capability system, moderation and cost normalization |
| `@image-sdk/sdk` | Beginner entry point — `generateImage()`, `editImage()`, auto-detected adapters |
| `@image-sdk/cli` | `image-sdk try` / `generate` / `providers` |
| `@image-sdk/react` | `useImageGeneration()` hook with loading/progress state |
| `@image-sdk/mcp` | MCP server for agent-native workflows |
| `@image-sdk/storage-s3` | Permanent re-hosting for expiring provider URLs |
| `@image-sdk/production` | Production-hardening helpers (guardrails, batching) |

---

## Project status

`image-sdk` is in **early access (v0.1)**. The core client, beginner API, job model, and eight
provider adapters are implemented and tested. Actively being hardened before a stable release:

- [ ] Default spend-safety guardrail active out of the box (currently opt-in via `limits`)
- [ ] Actionable, plain-language error messages for common setup mistakes
- [ ] Full documentation site

Track progress in [Issues](https://github.com/Adarsh-Me/Image-SDK/issues). Contributions and reports
against the checklist above are especially welcome while these land.

---

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

```bash
pnpm clean       # remove build output across all packages
pnpm changeset    # record a change for the next release
pnpm release      # build, test, and publish via changesets
```

Node.js 20+ required.

---

## Contributing

New provider adapters are the most valuable contribution. Each lives as a self-contained package under
`packages/providers/`, implementing the shared `Adapter` interface from `@image-sdk/core`: a capability
manifest, moderation-result mapping, and tests against the shared adapter contract suite.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).

<p align="center">Built by <a href="https://github.com/Adarsh-Me">Adarsh</a></p>
