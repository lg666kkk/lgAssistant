// Tool Registry = 工具仓库 / 工具注册表
/**
 * 把工具注册进去
 * 根据工具名取出来
 * 列出所有工具
 */
import type { ToolDefinition, ToolGroundingMode } from './types'

export class ToolRegistry {
    private tools = new Map<string, ToolDefinition>()
    // 注册工具
    register(tool: ToolDefinition): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool ${tool.name} already exists`)
        }
        this.tools.set(tool.name, tool)
    }
    // 获取工具
    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name)
    }
    // 获取工具列表
    list(): ToolDefinition[] {
        return Array.from(this.tools.values())
    }
    groundingModesFor(toolNames: Iterable<string>): Set<ToolGroundingMode> {
        const modes = new Set<ToolGroundingMode>()
        for (const name of Array.from(toolNames)) {
            const tool = this.tools.get(name)
            if (tool) modes.add(tool.outputPolicy.grounding)
        }
        return modes
    }
    toolsForCapability(capability: string): ToolDefinition[] {
        return this.list().filter(tool => tool.capabilities.includes(capability))
    }
    // 传给模型的工具列表
    listForModel(
        tools: ToolDefinition[] = this.list()
    ): Array<Pick<ToolDefinition, 'name' | 'description' | 'input_schema'>> {
        // capabilities 既供 Runtime 做依赖解析，也附在模型描述中帮助模型按能力选工具。
        // outputPolicy/orchestration 不直接传给 provider，避免把内部执行策略暴露成
        // 非标准 tool schema 字段；需要模型遵守的部分由 Prompt Pipe 单独渲染。
        return tools.map(tool => ({
            name: tool.name,
            description: `${tool.description}\n能力标签：${tool.capabilities.join(", ")}`,
            input_schema: tool.input_schema
        }))
    }
}
