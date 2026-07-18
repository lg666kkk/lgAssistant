import { timingSafeEqual } from "node:crypto";

type CronAuthEnvironment = {
  cronSecret?: string;
  nodeEnv?: string;
};

function bearerToken(header: string | null) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function secretsEqual(provided: string, expected: string) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function isAuthorizedCronRequest(
  req: Request,
  environment: CronAuthEnvironment = {
    cronSecret: process.env.CRON_SECRET,
    nodeEnv: process.env.NODE_ENV,
  },
) {
  const configuredSecret = environment.cronSecret?.trim();
  if (configuredSecret) {
    const provided = [
      bearerToken(req.headers.get("authorization")),
      req.headers.get("x-cron-secret")?.trim(),
    ].filter((value): value is string => Boolean(value));
    return provided.some((value) => secretsEqual(value, configuredSecret));
  }

  return (environment.nodeEnv === "development" || environment.nodeEnv === "test")
    && req.headers.get("x-scheduler-dev") === "1";
}
