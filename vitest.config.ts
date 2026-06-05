import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { config } from "dotenv";

// 坑2：lib/config.ts 在模块加载时就执行 validateEnv()，
// 只要 import 链碰到它就会校验环境变量。所以测试启动前先把 .env.local 注入 process.env，
// 否则一 import 就抛"缺少环境变量"。
config({ path: ".env.local" });

export default defineConfig({
  plugins: [tsconfigPaths()], // 坑1：解析 @/* 别名
  test: {
    environment: "node",
    setupFiles: ["./lib/test-setup.ts"], // 坑3：注入 WebSocket，见该文件注释
    include: ["lib/**/*.test.ts"],
    testTimeout: 30_000, // eval 真调模型时单 case 可能好几秒，给宽松超时
  },
});
