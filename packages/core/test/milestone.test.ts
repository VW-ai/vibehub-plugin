import { describe, expect, it } from "vitest";
import { classifyUserPrompt } from "../src/milestone.js";

describe("classifyUserPrompt (decision-workbench-001 mechanical tier)", () => {
  it("pure acknowledgements stay default — never milestone-tier", () => {
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
      expect(classifyUserPrompt(p), p).toBe("default");
    }
  });

  it("empty and whitespace-only prompts stay default", () => {
    expect(classifyUserPrompt("")).toBe("default");
    expect(classifyUserPrompt("   \n ")).toBe("default");
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

  it("short non-acks stay in the default tier — no ownerless LLM bucket", () => {
    expect(classifyUserPrompt("try the other branch")).toBe("default");
    expect(classifyUserPrompt("先别动 schema")).toBe("default");
    expect(classifyUserPrompt("why?")).toBe("default");
  });

  it("an ack prefix does not hide a structurally strong instruction", () => {
    expect(classifyUserPrompt("ok, but do this:\nskip the legacy path")).toBe("milestone");
    expect(classifyUserPrompt("好的,按下面做:\n先把测试跑绿")).toBe("milestone");
  });
});
