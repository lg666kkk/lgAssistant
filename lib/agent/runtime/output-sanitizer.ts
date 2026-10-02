const protocolMarker = /<\s*\/?\s*[|｜\s]+DSML\b/i;

export class ModelToolProtocolError extends Error {
  constructor() {
    super("模型返回了无法识别的工具调用格式，本次回答未完成，请重试或检查模型服务的工具调用兼容性。");
    this.name = "ModelToolProtocolError";
  }
}

export function hasToolProtocolText(text: string): boolean {
  return protocolMarker.test(text);
}

export function sanitizeModelText(text: string): string {
  // A leaked invocation is not an answer; its arguments must not become prose.
  const marker = text.search(protocolMarker);
  return marker < 0 ? text : text.slice(0, marker).trimEnd();
}

/** Holds partial markers across chunks so no protocol prefix reaches the UI. */
export function createModelTextFilter() {
  let pending = "";
  let leaked = false;
  return {
    push(text: string): string {
      if (leaked) return "";
      pending += text;
      const marker = pending.search(protocolMarker);
      if (marker >= 0) {
        leaked = true;
        const safe = pending.slice(0, marker);
        pending = "";
        return safe;
      }
      const opening = pending.lastIndexOf("<");
      if (opening >= 0 && /^<\s*\/?\s*[|｜\s]*(?:D(?:S(?:M(?:L)?)?)?)?$/i.test(pending.slice(opening))) {
        const safe = pending.slice(0, opening);
        pending = pending.slice(opening);
        return safe;
      }
      const safe = pending;
      pending = "";
      return safe;
    },
    finish(): string {
      const safe = leaked ? "" : pending;
      pending = "";
      return safe;
    },
    assertValid(): void {
      if (leaked) throw new ModelToolProtocolError();
    },
  };
}
