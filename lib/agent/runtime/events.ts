// Compatibility adapter. Shared transport contracts live in packages/contracts;
// runtime code may keep this path until the application layer is extracted.
import {
  serializeAgentEvent,
  type AgentEvent,
} from "@repo/contracts";

export * from "@repo/contracts";

export const serializeEvent = serializeAgentEvent;

export function enqueueEvent(
  event: AgentEvent,
  enqueueText: (text: string) => boolean,
): boolean {
  return enqueueText(serializeAgentEvent(event));
}
