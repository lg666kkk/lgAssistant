import { Langfuse } from "langfuse";
import type { LangfuseSpanClient, LangfuseTraceClient } from "langfuse";
import { resolveUserLangfuseConfig } from "./config";

export type UserLangfuseScope = {
  client: Langfuse;
  trace: LangfuseTraceClient;
};

type ObservationUpdate = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
};

class UserObservationAdapter {
  constructor(private readonly span: LangfuseSpanClient | null) {}

  update(input: ObservationUpdate) {
    this.span?.update(input);
  }

  end() {
    this.span?.end();
  }
}

export class UserTraceAdapter {
  constructor(
    private readonly traceClient: LangfuseTraceClient | null,
    readonly client: Langfuse | null,
  ) {}

  get id() {
    return this.traceClient?.id;
  }

  update(input: ObservationUpdate) {
    this.traceClient?.update(input);
  }

  setTraceIO(input: { input?: unknown; output?: unknown }) {
    this.traceClient?.update(input);
  }

  startObservation(
    name: string,
    input: ObservationUpdate = {},
    _options?: { asType?: string },
  ) {
    return new UserObservationAdapter(this.traceClient?.span({ name, ...input }) ?? null);
  }
}

export async function createUserLangfuseScope(input: {
  userId: string;
  name: string;
  sessionId?: string;
  traceInput?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}): Promise<UserLangfuseScope | null> {
  const config = await resolveUserLangfuseConfig(input.userId);
  if (!config) return null;
  const client = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });
  const trace = client.trace({
    name: input.name,
    userId: input.userId,
    sessionId: input.sessionId,
    input: input.traceInput,
    metadata: input.metadata,
    tags: input.tags,
    environment: process.env.NODE_ENV ?? "development",
  });
  return { client, trace };
}

export async function flushUserLangfuseScope(scope: UserLangfuseScope | null) {
  if (!scope) return;
  await scope.client.flushAsync();
}

export async function withUserLangfuseTrace<T>(input: {
  userId: string;
  name: string;
  sessionId?: string;
  traceInput?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
}, callback: (trace: UserTraceAdapter, client: Langfuse | null) => Promise<T>) {
  let scope: UserLangfuseScope | null = null;
  try {
    scope = await createUserLangfuseScope(input);
  } catch (error) {
    console.error("[langfuse] 用户配置加载失败，跳过外部上报:", error instanceof Error ? error.message : error);
  }
  const adapter = new UserTraceAdapter(scope?.trace ?? null, scope?.client ?? null);
  try {
    return await callback(adapter, scope?.client ?? null);
  } finally {
    await flushUserLangfuseScope(scope).catch((error) =>
      console.error("[langfuse] flush 失败，跳过:", error instanceof Error ? error.message : error));
  }
}
