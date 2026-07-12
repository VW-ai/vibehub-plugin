import { describe, expect, it } from "vitest";
import { classifyUserPrompt } from "../src/milestone.js";

describe("classifyUserPrompt (decision-workbench-001 mechanical tier)", () => {
  it("pure acknowledgements are routine — never milestone-tier", () => {
    for (const p of [
      "ok",
      "OK!",
      "yes",
      "继续",
      "好的",
      "好的,继续!",
      "嗯嗯",
      "sounds good",
      "LGTM",
      "go ahead",
      "do it",
      "没问题",
    ]) {
      expect(classifyUserPrompt(p), p).toBe("routine");
    }
  });

  it("empty and whitespace-only prompts are routine", () => {
    expect(classifyUserPrompt("")).toBe("routine");
    expect(classifyUserPrompt("   \n ")).toBe("routine");
  });

  it("long prompts are milestone on their face", () => {
    expect(
      classifyUserPrompt(
        "把注入队列的送达确认改成读侧推导,不要存超时状态,然后在 UI 上用 createdAt 年龄显示未送达警告,这条规则要写进 spec。",
      ),
    ).toBe("milestone");
    expect(
      classifyUserPrompt(
        "Refactor the delivery wrapper so a single pause in the batch makes the whole batch pause, and add tests for the FIFO ordering guarantee.",
      ),
    ).toBe("milestone");
  });

  it("structure = payload: multi-line, code fence, URL, file path", () => {
    expect(classifyUserPrompt("fix this:\nsecond line")).toBe("milestone");
    expect(classifyUserPrompt("run ```npm test```")).toBe("milestone");
    expect(classifyUserPrompt("see https://code.claude.com/docs/en/hooks")).toBe("milestone");
    expect(classifyUserPrompt("look at src/hook-ingest.ts")).toBe("milestone");
  });

  it("short non-acks are ambiguous — the honest middle for the thin LLM", () => {
    expect(classifyUserPrompt("try the other branch")).toBe("ambiguous");
    expect(classifyUserPrompt("先别动 schema")).toBe("ambiguous");
    expect(classifyUserPrompt("why?")).toBe("ambiguous");
  });

  it("an ack with substantive tail is NOT routine", () => {
    expect(classifyUserPrompt("ok, but skip the legacy path")).not.toBe("routine");
    expect(classifyUserPrompt("好的,但是先把测试跑绿")).not.toBe("routine");
  });
});
