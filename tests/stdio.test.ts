import test from "node:test";
import assert from "node:assert/strict";

import { createStdioLineProcessor } from "../packages/service/src/stdio.js";
import { DEVCREW_VERSION } from "../packages/core/src/index.js";

function parseMessages(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("stdio line processor returns parse errors without throwing", async () => {
  const output: string[] = [];
  const processLine = createStdioLineProcessor((message) => output.push(`${JSON.stringify(message)}\n`));

  await processLine("{not-json");

  const messages = parseMessages(output);
  assert.equal(messages[0].jsonrpc, "2.0");
  assert.equal(messages[0].id, null);
  assert.deepEqual(messages[0].error, {
    code: -32700,
    message: "Parse error",
  });
});

test("stdio rejects valid JSON with an invalid request shape", async () => {
  for (const line of [
    "null",
    "[]",
    JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1 }),
  ]) {
    const output: unknown[] = [];
    const processLine = createStdioLineProcessor((message) => output.push(message));

    await processLine(line);

    assert.deepEqual((output[0] as { error: unknown }).error, {
      code: -32600,
      message: "Invalid Request",
    });
  }
});

test("stdio line processor ignores initialized notifications", async () => {
  const output: string[] = [];
  const processLine = createStdioLineProcessor((message) => output.push(`${JSON.stringify(message)}\n`));

  await processLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));

  assert.deepEqual(output, []);
});

test("stdio line processor serializes requests in arrival order", async () => {
  const output: string[] = [];
  const calls: string[] = [];
  const processLine = createStdioLineProcessor(
    (message) => output.push(`${JSON.stringify(message)}\n`),
    async (request) => {
      calls.push(String(request.id));
      await new Promise((resolve) => setTimeout(resolve, request.id === 1 ? 10 : 0));
    },
  );

  const first = processLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const second = processLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  await Promise.all([first, second]);

  assert.deepEqual(calls, ["1", "2"]);
});

test("stdio continues after a queued handler rejects", async () => {
  const calls: string[] = [];
  const processLine = createStdioLineProcessor(() => {}, async (request) => {
    calls.push(String(request.id));
    if (request.id === 1) {
      throw new Error("first failed");
    }
  });

  await assert.rejects(
    () => processLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
    /first failed/,
  );
  await processLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));

  assert.deepEqual(calls, ["1", "2"]);
});

test("stdio initialize response uses the shared DevCrew version", async () => {
  const output: string[] = [];
  const processLine = createStdioLineProcessor((message) => output.push(`${JSON.stringify(message)}\n`));

  await processLine(JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize" }));

  const messages = parseMessages(output);
  assert.deepEqual((messages[0].result as { serverInfo: unknown }).serverInfo, {
    name: "devcrew",
    version: DEVCREW_VERSION,
  });
});
