import dotenv from "dotenv";
import { processRagIngestionBatch } from "../lib/knowledge/ingestion-queue";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

async function main() {
  const result = await processRagIngestionBatch({
    workerId: `cli-${process.pid}-${crypto.randomUUID()}`,
    limit: Number(process.env.RAG_INGESTION_BATCH_SIZE ?? 2),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
