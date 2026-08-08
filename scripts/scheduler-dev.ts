import { config } from "dotenv";
import cron from "node-cron";

config({ path: ".env.local" });
config();

const target =
  process.env.SCHEDULER_TICK_URL ??
  `http://localhost:${process.env.PORT ?? "3000"}/api/cron/tick`;

const secret = process.env.CRON_SECRET;

async function callTick() {
  const url = new URL(target);
  const headers: Record<string, string> = {
    "x-scheduler-dev": "1",
  };
  if (secret) headers["x-cron-secret"] = secret;

  await fetch(url, { headers });
}

void callTick().catch((error) => console.error("[scheduler-dev] tick failed:", error));

cron.schedule("* * * * *", () => {
  void callTick().catch((error) => console.error("[scheduler-dev] tick failed:", error));
});
