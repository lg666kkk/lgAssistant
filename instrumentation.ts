export async function register() {
  // Langfuse 使用当前用户的请求级 Client，不注册全局 OTel Processor，避免跨租户串线。
}
