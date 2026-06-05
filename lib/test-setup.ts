// vitest 全局 setup
// 坑3：supabase-js 在 Node 20 下 createClient 会初始化 realtime 客户端，
// 而 Node < 22 没有原生 WebSocket，导致直接抛错（即便我们根本不用 realtime）。
// 把已安装的 ws 挂到全局 WebSocket，supabase-js 检测到即不再报错。
// 仅测试环境需要；业务运行时（Next.js）自带 WebSocket。
import ws from "ws";

if (typeof globalThis.WebSocket === "undefined") {
  // @ts-expect-error ws 的类型与 DOM WebSocket 不完全一致，运行时够用
  globalThis.WebSocket = ws;
}
