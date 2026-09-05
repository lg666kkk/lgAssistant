import { requireUser } from "@/lib/auth/server";
import { validateSchedule } from "@/lib/scheduler/cron";
import {
  createScheduledJob,
  deleteScheduledJob,
  listScheduledJobs,
  loadScheduledJob,
  updateScheduledJob,
} from "@/lib/scheduler/store";
import type { ScheduledJobType } from "@/lib/scheduler/types";
import { listRecentDeliveries } from "@/lib/scheduler/deliveries";
import { normalizeScheduledJobPayload } from "@/lib/scheduler/validation";
import { resolveUserLlmModel } from "@/lib/llm/config-service";
import type { ScheduledJobPayload } from "@/lib/scheduler/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB_TYPES = new Set<ScheduledJobType>([
  "reminder",
  "leetcode-daily",
  "agent-task",
]);

function toRunAt(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function hasOwn(object: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

async function validateTaskModel(
  userId: string,
  type: ScheduledJobType,
  payload: ScheduledJobPayload,
) {
  if (type !== "agent-task") return;
  const modelId = typeof payload.modelId === "string" && payload.modelId.trim()
    ? payload.modelId.trim()
    : null;
  const model = await resolveUserLlmModel(userId, modelId);
  if (!model.supportsTools) {
    throw new Error("定时 Agent 任务只能使用支持工具调用的模型");
  }
  payload.modelId = model.id;
}

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  try {
    const [jobs, deliveries] = await Promise.all([
      listScheduledJobs(user.id),
      listRecentDeliveries(user.id),
    ]);
    return Response.json({ ok: true, jobs, deliveries });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "List scheduled jobs failed",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体需要是 JSON" }, { status: 400 });
  }

  const type = body.type as ScheduledJobType;
  if (!JOB_TYPES.has(type)) {
    return Response.json({ ok: false, error: "未知任务类型" }, { status: 400 });
  }

  const timezone = typeof body.timezone === "string" ? body.timezone : "Asia/Shanghai";
  const cron = typeof body.cron === "string" && body.cron.trim() ? body.cron.trim() : null;
  const runAt = toRunAt(body.runAt);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

  try {
    const nextRunAt = validateSchedule({ cron, runAt, timezone });
    const payload = normalizeScheduledJobPayload(type, body.payload ?? {});
    if (enabled) await validateTaskModel(user.id, type, payload);
    const job = await createScheduledJob({
      userId: user.id,
      type,
      cron,
      runAt: cron ? null : runAt,
      nextRunAt,
      timezone,
      payload,
      enabled,
    });

    return Response.json({ ok: true, job });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Create scheduled job failed",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
  }

  try {
    await deleteScheduledJob({ id, userId: user.id });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Delete scheduled job failed",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "请求体需要是 JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || typeof body.id !== "string") {
    return Response.json({ ok: false, error: "缺少 id" }, { status: 400 });
  }

  const existing = await loadScheduledJob(body.id);
  if (!existing || existing.userId !== user.id) {
    return Response.json({ ok: false, error: "任务不存在" }, { status: 404 });
  }

  const type = (body.type ?? existing.type) as ScheduledJobType;
  if (!JOB_TYPES.has(type)) {
    return Response.json({ ok: false, error: "未知任务类型" }, { status: 400 });
  }

  if (hasOwn(body, "cron") && hasOwn(body, "runAt") && body.cron && body.runAt) {
    return Response.json({ ok: false, error: "cron 和 runAt 只能二选一" }, { status: 400 });
  }

  const timezone = typeof body.timezone === "string" ? body.timezone : existing.timezone;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : existing.enabled;
  const rawPayload =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload
      : existing.payload;

  let cron = existing.cron;
  let runAt = existing.runAt;
  if (hasOwn(body, "cron")) {
    cron = typeof body.cron === "string" && body.cron.trim() ? body.cron.trim() : null;
    if (cron) runAt = null;
  }
  if (hasOwn(body, "runAt")) {
    runAt = toRunAt(body.runAt);
    if (runAt) cron = null;
  }

  try {
    const nextRunAt = enabled
      ? validateSchedule({ cron, runAt, timezone })
      : existing.nextRunAt;
    const payload = normalizeScheduledJobPayload(type, rawPayload);
    if (enabled) await validateTaskModel(user.id, type, payload);
    const job = await updateScheduledJob({
      id: existing.id,
      userId: user.id,
      type,
      cron,
      runAt: cron ? null : runAt,
      nextRunAt,
      timezone,
      payload,
      enabled,
    });

    return Response.json({ ok: true, job });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Update scheduled job failed",
      },
      { status: 400 },
    );
  }
}
