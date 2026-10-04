import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../agent-runtime.js";

describe("installAgentRuntimeMethods", () => {
  // 回归：AgentRuntime 通过 declare 合并声明这些方法，类型检查无法发现原型上漏装；
  // 漏装时每个用户 turn 在 admission 处抛 TypeError，桌面端发送后无任何响应。
  it("installs session execution target accessors used by turn admission", () => {
    const proto = AgentRuntime.prototype as unknown as Record<string, unknown>;

    expect(typeof proto.getSessionExecutionTarget).toBe("function");
    expect(typeof proto.setSessionExecutionTarget).toBe("function");
  });
});
