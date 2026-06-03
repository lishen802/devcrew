import { callDevCrewTool, listDevCrewTools } from "./tools.js";

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function writeJson(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined || request.id === null) {
    return;
  }

  try {
    if (request.method === "initialize") {
      writeJson({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "devcrew", version: "0.1.0" },
        },
      });
      return;
    }

    if (request.method === "tools/list") {
      writeJson({
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
      writeJson({
        jsonrpc: "2.0",
        id: request.id,
        result,
      });
      return;
    }

    throw new Error(`Unsupported JSON-RPC method: ${request.method ?? "unknown"}`);
  } catch (error) {
    writeJson({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function runStdioServer(): void {
  let buffer = "";
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
      void handleRequest(JSON.parse(trimmed) as JsonRpcRequest);
    }
  });
}
