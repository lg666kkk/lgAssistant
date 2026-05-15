// Tool Registry = 工具仓库 / 工具注册表
/**
 * 把工具注册进去
 * 根据工具名取出来
 * 列出所有工具
 */
import type { ToolDefinition } from './types'

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
    // 传给模型的工具列表
    listForModel(): Array<Pick<ToolDefinition, 'name' | 'description' | 'input_schema'>> {
        return this.list().map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema
        }))
    }
}
