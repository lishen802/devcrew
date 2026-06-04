import { callDevCrewTool, listDevCrewTools } from "./tools.js";
import { DEVCREW_VERSION } from "../../core/src/index.js";

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonWriter = (message: unknown) => void;
type RequestHandler = (request: JsonRpcRequest) => Promise<void>;

function writeJson(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(request: JsonRpcRequest, write: JsonWriter): Promise<void> {
  if (request.method === "notifications/initialized") {
    return;
  }

  if (request.id === undefined || request.id === null) {
    return;
  }

  try {
    if (request.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "devcrew", version: DEVCREW_VERSION },
        },
      });
      return;
    }

    if (request.method === "tools/list") {
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: listDevCrewTools() },
      });
      return;
    }

    if (request.method === "tools/call") {
      const params = request.params ?? {};
      const name = params.name;
      if (typeof name !== "string") {
        throw new Error("tools/call params.name must be a string");
      }
      const result = await callDevCrewTool(name, (params.arguments ?? {}) as Record<string, unknown>);
      write({
        jsonrpc: "2.0",
        id: request.id,
        result,
      });
      return;
    }

    throw new Error(`Unsupported JSON-RPC method: ${request.method ?? "unknown"}`);
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function createStdioLineProcessor(
  write: JsonWriter = writeJson,
  handler: RequestHandler = (request) => handleRequest(request, write),
): (line: string) => Promise<void> {
  let queue = Promise.resolve();
  return async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return queue;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return queue;
    }

    queue = queue.then(() => handler(request));
    return queue;
  };
}

export function runStdioServer(): void {
  let buffer = "";
  const processLine = createStdioLineProcessor();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      void processLine(trimmed);
    }
  });
}
