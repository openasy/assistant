import { describe, expect, it } from "vitest";
import { citations, networkOf, type Source } from "./assistant.ts";

const source = (n: number, status: Source["status"]): Source => ({
  n,
  tool: "logs_search",
  source: "logs",
  args: {},
  status,
  title: "",
  detail: "",
  href: null,
  count: 0,
  ms: 0,
  error: null,
});

describe("citations", () => {
  const sources = [source(1, "ok"), source(2, "empty"), source(3, "error"), source(4, "ok")];

  it("are the calls the answer names, in its own forms of writing them", () => {
    expect(citations("CPU was high [1]. No errors [2]. Both [1, 4]. [Source: 4]", sources)).toEqual({
      text: "CPU was high [1]. No errors [2]. Both [1][4]. [4]",
      cited: [1, 2, 4],
    });
  });

  it("leave out calls that failed or were never made, so a claim cannot point at nothing", () => {
    expect(citations("It failed [3]. Made up [9]. Real [4]", sources)).toEqual({ text: "It failed. Made up. Real [4]", cited: [4] });
  });

  it("leave numbers in brackets that come from the data as they are", () => {
    expect(citations("The line reads CRON[812]: (root) CMD and args[1] [4].", sources)).toEqual({
      text: "The line reads CRON[812]: (root) CMD and args[1] [4].",
      cited: [4],
    });
  });
});

describe("where the model is", () => {
  it("is told from its address", () => {
    expect(["localhost", "127.0.0.1", "::1", "assistant.localhost"].map(networkOf)).toEqual(["this-host", "this-host", "this-host", "this-host"]);
    expect(["ollama", "10.1.2.3", "192.168.1.9", "172.20.0.4", "llm.internal", "gpu.lan", "fd12:3456::1"].map(networkOf)).toEqual(Array(7).fill("private"));
    expect(["api.anthropic.com", "api.openai.com", "8.8.8.8", "172.32.0.1", "2001:db8::1"].map(networkOf)).toEqual(Array(5).fill("internet"));
  });
});
