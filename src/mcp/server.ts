import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContainer } from "../app/container.js";
import { withActor } from "../app/container.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { registerTools } from "./tools.js";

export const SERVER_INFO = { name: "lead-engine", version: "0.1.0" } as const;

/**
 * One factory for every transport (stdio and Streamable HTTP), so the tool
 * names, schemas, annotations, and instructions cannot diverge between them.
 * The actor becomes `mcp:<clientName>` after the initialize handshake.
 */
export function buildMcpServer(base: AppContainer): McpServer {
  const server = new McpServer(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    { instructions: SERVER_INSTRUCTIONS },
  );
  let app = withActor(base, "mcp:unknown");
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    app = withActor(base, `mcp:${client?.name ?? "unknown"}`);
  };
  registerTools(server, () => app);
  return server;
}
