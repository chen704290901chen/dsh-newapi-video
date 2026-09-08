// dsh-newapi-video — type surface for TypeScript consumers.
import type { Schema } from "@deepseek-ai/schemastery";

export const name: "newapi-video";
export const inject: string[];

export interface NewapiVideoConfig {
  enabled: boolean;
  mode: "openai-videos" | "modelverse-tasks" | "generic-rest";
  baseURL: string;
  apiKey: string;
  apiKeyEnv: string;
  model: string;
  outputDir: string;
  timeoutMs: number;
  pollIntervalMs: number;
  maxPollAttempts: number;
  aspectRatio: string;
  durationSeconds: number;
  resolution: string;
  submitPath: string;
  statusPathTemplate: string;
  taskIdField: string;
  statusField: string;
  urlsField: string;
}

export const Config: Schema<NewapiVideoConfig>;

export function apply(ctx: unknown, config?: Partial<NewapiVideoConfig>): void;
