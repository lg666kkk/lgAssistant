import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSidebar, getConnectionTabLabel, type PrimaryCapability } from "./app-sidebar";

function renderSidebar(activeCapability: PrimaryCapability) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(AppSidebar, {
    open: true,
    activeCapability,
    activeConnectionTab: activeCapability === "logs" ? "usage" : "language-model",
    activeCustomAgentTab: "english",
    sessions: [],
    activeSessionId: "",
    onCapabilityChange: noop,
    onConnectionTabChange: noop,
    onCustomAgentTabChange: noop,
    onCreateSession: noop,
    onSwitchSession: noop,
    onStopSession: noop,
    onOpenSessionDialog: noop,
    onSignIn: noop,
    onSignOut: noop,
  }));
}

describe("sidebar log navigation", () => {
  it("hides customization and removes log pages from connections", () => {
    const html = renderSidebar("connections");
    expect(html).toContain("日志");
    expect(html).not.toContain("定制化");
    expect(html).not.toContain("用量统计");
    expect(html).not.toContain("Trace");
    expect(html).not.toContain("Langfuse");
    expect(html).toContain("沙盒环境");
  });

  it("groups usage, Trace and Langfuse under logs in order", () => {
    const html = renderSidebar("logs");
    expect(html).toContain('aria-label="日志"');
    expect(html.indexOf("用量统计")).toBeLessThan(html.indexOf("Trace"));
    expect(html.indexOf("Trace")).toBeLessThan(html.indexOf("Langfuse"));
    expect(html).not.toContain("沙盒环境");
    expect(getConnectionTabLabel("usage")).toBe("用量统计");
    expect(getConnectionTabLabel("traces")).toBe("Trace");
    expect(getConnectionTabLabel("langfuse")).toBe("Langfuse");
  });
});
