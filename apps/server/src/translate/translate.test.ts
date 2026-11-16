import { describe, expect, it } from "vitest";
import { detectScript } from "../translate/lang";
import { buildTranslatePrompt } from "../translate/prompt";

describe("detectScript", () => {
  it("classifies chinese", () => {
    expect(detectScript("堆场派位策略研究")).toBe("zh");
  });
  it("classifies english", () => {
    expect(detectScript("Yard crane scheduling under uncertainty")).toBe("en");
  });
  it("classifies japanese via kana", () => {
    expect(detectScript("コンテナヤードの配置計画")).toBe("ja");
  });
  it("classifies korean", () => {
    expect(detectScript("컨테이너 야드 배치")).toBe("ko");
  });
  it("classifies russian", () => {
    expect(detectScript("расписание контейнерного двора")).toBe("ru");
  });
  it("dominant script wins for mixed content", () => {
    // Latin-dominant: English body with Chinese terms -> en.
    expect(detectScript("AGV scheduling AGV 调度算法 调度 调度")).toBe("en");
    expect(
      detectScript("Yard crane scheduling and 堆场 planning algorithms"),
    ).toBe("en");
    // Han-dominant: Chinese body with English terms -> zh.
    expect(
      detectScript("本页研究堆场派位与泊位分配的调度算法与 AGV 路径规划问题"),
    ).toBe("zh");
  });
  it("returns null for digits/symbols only", () => {
    expect(detectScript("2026 / 05 400")).toBeNull();
    expect(detectScript("")).toBeNull();
  });
});

describe("buildTranslatePrompt", () => {
  it("injects count, direction and glossary terms", () => {
    const p = buildTranslatePrompt("zh", "en", 3, [
      { src: "堆场", dst: "yard" },
      { src: "", dst: "ignored" },
    ]);
    expect(p).toContain("3");
    expect(p).toContain("zh");
    expect(p).toContain("en");
    expect(p).toContain("堆场 -> yard");
    expect(p).not.toContain("ignored");
    expect(p).toContain("JSON");
  });
  it("omits the glossary block when empty", () => {
    const p = buildTranslatePrompt("", "zh", 1, []);
    expect(p).not.toContain("术语表");
    expect(p).toContain("自动识别");
  });
});
