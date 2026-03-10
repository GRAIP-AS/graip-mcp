# Graip MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes the [Graip.AI](https://graip.ai) document-processing API as MCP tools. This lets any MCP-compatible AI client (Claude Desktop, VS Code Copilot, Cursor, etc.) upload documents, extract structured data, and manage processing flows through natural language.

---

## Features

| Tool | Description |
|---|---|
| **add-flow** | Register a named flow (e.g. "invoices") mapped to a Graip flow ID |
| **remove-flow** | Remove a previously registered flow |
| **list-flows** | List all flows configured for the current user |
| **extract-document** | Upload a document, process it, and return extracted data |

Supported file formats: **PDF, PNG, JPEG, TIFF, ZIP** (max 50 MB, max 10 pages per PDF/TIFF).

---

## Prerequisites

- **Node.js** ≥ 18
- A **Graip.AI API key** — obtain one from **Flow → Settings → Integration → New Access Token** in the Graip.AI app.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Run

```bash
npm start
```

The server starts on **port 7891** by default. Override with the `MCP_PORT` environment variable:

```bash
MCP_PORT=8080 npm start
```

### 4. Development (watch mode)

```bash
npm run dev        # rebuilds on file changes
node dist/index.js # run in a separate terminal
```

---

## Authentication

Every request must include your Graip.AI API key in the `Authorization` header:

```
Authorization: Bearer <YOUR_GRAIP_API_KEY>
```

Both `Bearer <key>` and raw `<key>` formats are accepted.

### Optional headers

| Header | Description |
|---|---|
| `X-Graip-Flow-Id` | Default flow ID used when neither `flow` nor `flowId` is provided to `extract-document` |

---

## MCP Endpoint

The server exposes a single MCP endpoint using the **Streamable HTTP** transport:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp` | Send JSON-RPC requests (tool calls, initialization) |
| `GET` | `/mcp` | Open an SSE stream for server-sent events |
| `DELETE` | `/mcp` | Terminate a session |

Sessions are identified by the `mcp-session-id` header returned after initialization.

---

## Connecting from AI Clients

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "graip": {
      "url": "http://localhost:7891/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_GRAIP_API_KEY>"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to your VS Code settings (`.vscode/mcp.json`):

```json
{
  "servers": {
    "graip": {
      "type": "http",
      "url": "http://localhost:7891/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_GRAIP_API_KEY>"
      }
    }
  }
}
```

### Cursor

Add to your Cursor MCP config (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "graip": {
      "url": "http://localhost:7891/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_GRAIP_API_KEY>"
      }
    }
  }
}
```

---

## Usage Examples

Once connected, you can interact with the tools through natural language in your AI client.

### Register a flow

> "Add a flow called **invoices** with ID `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`."

The flow ID is found at the end of the URL when a flow is selected in the Graip.AI app.

### List flows

> "Show me my configured flows."

### Extract data from a document

> "Extract data from the attached invoice using the **invoices** flow."

Or provide a raw flow ID:

> "Process this PDF with flow ID `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`."

The tool accepts base64-encoded files and returns the full extracted data as structured JSON.

### Remove a flow

> "Remove the **invoices** flow."

---

## Per-User Configuration

Flow configurations are stored locally in `~/.graip-mcp/users/` and keyed by a hash of the API key. This means:

- Each API key has its own set of named flows.
- Configurations persist across server restarts.
- No database is required.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `7891` | Port the HTTP server listens on |

---

## Project Structure

```
graip-mcp/
├── src/
│   └── index.ts          # MCP server, tools, and Express app
├── openapi.yaml           # Graip.AI REST API OpenAPI spec
├── logo.svg               # Server icon
├── package.json
└── tsconfig.json
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Compile in watch mode |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type-check without emitting |

---

## License

MIT — [Graip.AI](https://graip.ai)
