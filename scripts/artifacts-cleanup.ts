import dotenv from "dotenv";
import { cleanupToolArtifacts } from "../lib/agent/runtime/artifact-store";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

async function main() {
  const result = await cleanupToolArtifacts();
  console.log(
    [
      "Artifact cleanup complete",
      `scanned=${result.scannedFiles}`,
      `expired=${result.deletedExpiredFiles}`,
      `overflow=${result.deletedOverflowFiles}`,
      `freedBytes=${result.freedBytes}`,
      `retainedBytes=${result.retainedBytes}`,
    ].join(" "),
  );
}

main().catch((error) => {
  console.error(
    "Artifact cleanup failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
