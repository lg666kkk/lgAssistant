import { createBuiltinToolRegistry } from "../lib/agent/tools/builtin";
import { executeToolCall } from "../lib/agent/tools/tool-router";

async function main() {
  const registry = createBuiltinToolRegistry();
  const toolCall = {
    name: "get_current_time",
    input: {
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  };
  await executeToolCall(registry, toolCall);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
