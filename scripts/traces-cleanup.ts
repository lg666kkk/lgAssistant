import dotenv from "dotenv";
import { getSupabase } from "../lib/platform/supabase";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

async function main() {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("purge_expired_agent_traces");
  if (error) throw new Error(`清理过期 Trace 失败: ${error.message}`);
  const operational = await supabase.rpc("purge_expired_rag_operational_data");
  if (operational.error && !operational.error.message.includes("does not exist")) {
    throw new Error(`清理过期 RAG 运维数据失败: ${operational.error.message}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
