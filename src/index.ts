import { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
    CallToolResult,
    isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';


const API_BASE = 'https://app.graip.ai/api';
const USER_AGENT = 'graip-mcp/1.0';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.zip']);
const MAX_BASE64_WARNING_BYTES = 1 * 1024 * 1024; // 1 MB – warn when base64 decodes to more

const CONFIG_DIR = path.join(os.homedir(), '.graip-mcp');
const USERS_DIR = path.join(CONFIG_DIR, 'users');

interface FlowEntry {
    flowId: string;
    description?: string;
}

// ---------------------------------------------------------------------------
// Per-user flow config – keyed by a hash of the API key
// ---------------------------------------------------------------------------

interface UserFlowConfig {
    flows: Record<string, FlowEntry>;
}

function userConfigPath(apiKey: string): string {
    const hash = createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
    return path.join(USERS_DIR, `${hash}.json`);
}

function loadUserFlows(apiKey: string): UserFlowConfig {
    try {
        const p = userConfigPath(apiKey);
        if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<UserFlowConfig>;
            return { flows: parsed.flows ?? {} };
        }
    } catch {
        // Ignore corrupt file – start fresh
    }
    return { flows: {} };
}

function saveUserFlows(apiKey: string, config: UserFlowConfig): void {
    if (!fs.existsSync(USERS_DIR)) {
        fs.mkdirSync(USERS_DIR, { recursive: true });
    }
    fs.writeFileSync(userConfigPath(apiKey), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Extract the API key from the Authorization header.
 * Supports both "Bearer <key>" and raw "<key>" formats.
 */
function extractApiKey(req: Request): string | undefined {
    const header = req.headers['authorization'];
    if (!header) return undefined;
    return header.startsWith('Bearer ') ? header.slice(7) : header;
}

// ---------------------------------------------------------------------------
// Graip API helpers
// ---------------------------------------------------------------------------

interface GraipError {
    error: string;
    details: string;
}

interface GraipRequest {
    id: string;
    title: string;
    status: 'DRAFT' | 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'ERROR';
    status_info?: GraipError | null;
    created_by_id: string | null;
    assigned_id: string | null;
    created_at: string;
    updated_at: string;
    approval_status: string;
    block_status: string;
}

interface GraipRequestWithData extends GraipRequest {
    data: Record<string, unknown>;
}

async function graipUpload<T>(
    apiKey: string,
    urlPath: string,
    fileBuffer: Buffer,
    fileName: string,
    extraFields?: Record<string, string>,
): Promise<T> {
    const url = `${API_BASE}${urlPath}`;

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(fileBuffer)]);
    formData.append('file', blob, fileName);

    if (extraFields) {
        for (const [key, value] of Object.entries(extraFields)) {
            formData.append(key, value);
        }
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            Authorization: apiKey,
        },
        body: formData,
    });

    if (!response.ok) {
        let errorBody: string;
        try {
            const errJson = (await response.json()) as GraipError;
            errorBody = `${errJson.error}: ${errJson.details}`;
        } catch {
            errorBody = await response.text();
        }
        throw new Error(`Graip API error (${response.status}): ${errorBody}`);
    }

    return response.json() as Promise<T>;
}

/**
 * Validate that a file name has an allowed extension.
 * Returns the normalised extension (e.g. ".pdf") or an error string.
 */
function validateExtension(fileName: string): { ok: true; ext: string } | { ok: false; error: string } {
    const ext = path.extname(fileName).toLowerCase();
    if (!ext) {
        return { ok: false, error: `File "${fileName}" has no extension. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` };
    }
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return { ok: false, error: `Extension "${ext}" is not supported. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` };
    }
    return { ok: true, ext };
}

/**
 * Download a file from a URL into a Buffer.
 */
async function downloadFile(url: string): Promise<{ buffer: Buffer; fileName: string }> {
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
    });
    if (!response.ok) {
        throw new Error(`Failed to download file (${response.status}): ${response.statusText}`);
    }
    const arrayBuf = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // Try to derive a file name from the URL path
    let fileName: string;
    try {
        const urlPath = new URL(url).pathname;
        fileName = path.basename(urlPath) || 'download';
    } catch {
        fileName = 'download';
    }
    return { buffer, fileName };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const getServer = (apiKey: string, headerFlowId?: string) => {
    const server = new McpServer(
        {
            name: 'graip-mcp',
            version: '1.0.0',
            icons: [{ src: './logo.svg', sizes: ['512x512'], mimeType: 'image/svg+xml' }],
            websiteUrl: 'https://graip.ai',
        },
        {
            capabilities: { logging: {} },
        },
    );

    /** Resolve a flow name to its ID using the current user's config. */
    function resolveFlowId(flowName: string): string {
        const { flows } = loadUserFlows(apiKey);
        const entry = flows[flowName];
        if (!entry) {
            const available = Object.keys(flows);
            throw new Error(
                `Flow "${flowName}" not found. ` +
                (available.length
                    ? `Available flows: ${available.join(', ')}`
                    : 'No flows configured. Use the "add-flow" tool first.'),
            );
        }
        return entry.flowId;
    }

    // ---- Tool: add-flow ---------------------------------------------------
    server.registerTool(
        'add-flow',
        {
            title: 'Add Flow',
            description:
                'Register a named flow so you can reference it by name when extracting documents. ' +
                'For example, add a flow named "invoices" for invoice processing and "po" for purchase orders. ' +
                'The flow ID can be found at the end of the URL when a flow is selected in Graip.AI. ' +
                'Flows are saved per user and persist across sessions.',
            inputSchema: {
                name: z.string()
                    .describe('Short name for the flow, e.g. "invoices", "purchase orders", "contracts", "passports"'),
                flowId: z.string()
                    .describe('The Graip.AI flow ID'),
                description: z.string().optional()
                    .describe('Optional human-readable description of what this flow processes'),
            },
        },
        async ({ name, flowId, description }): Promise<CallToolResult> => {
            const userConfig = loadUserFlows(apiKey);
            const existed = name in userConfig.flows;
            userConfig.flows[name] = { flowId, description };
            saveUserFlows(apiKey, userConfig);
            return {
                content: [{
                    type: 'text',
                    text: existed
                        ? `Flow "${name}" updated → ${flowId}`
                        : `Flow "${name}" added → ${flowId}`,
                }],
            };
        },
    );

    // ---- Tool: remove-flow ------------------------------------------------
    server.registerTool(
        'remove-flow',
        {
            title: 'Remove Flow',
            description: 'Remove a previously configured flow by name.',
            inputSchema: {
                name: z.string().describe('Name of the flow to remove'),
            },
        },
        async ({ name }): Promise<CallToolResult> => {
            const userConfig = loadUserFlows(apiKey);
            if (!(name in userConfig.flows)) {
                return {
                    content: [{ type: 'text', text: `Flow "${name}" not found.` }],
                    isError: true,
                };
            }
            delete userConfig.flows[name];
            saveUserFlows(apiKey, userConfig);
            return {
                content: [{ type: 'text', text: `Flow "${name}" removed.` }],
            };
        },
    );

    // ---- Tool: list-flows -------------------------------------------------
    server.registerTool(
        'list-flows',
        {
            title: 'List Flows',
            description: 'List all configured flows for the current user.',
            inputSchema: {},
        },
        async (): Promise<CallToolResult> => {
            const { flows } = loadUserFlows(apiKey);
            const lines: string[] = [];

            const flowNames = Object.keys(flows);
            if (flowNames.length === 0) {
                lines.push('No flows configured. Use "add-flow" to register one.');
            } else {
                lines.push(`Flows (${flowNames.length}):`);
                for (const name of flowNames) {
                    const entry = flows[name];
                    const desc = entry.description ? ` – ${entry.description}` : '';
                    lines.push(`  • ${name}: ${entry.flowId}${desc}`);
                }
            }

            lines.push('');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        },
    );

    // ---- Tool: extract-document -------------------------------------------
    server.registerTool(
        'extract-document',
        {
            title: 'Extract Document',
            description:
                'Upload a document to Graip.AI, process it, and return the extracted data ' +
                'in a single request. Supported formats: PDF, PNG, JPEG, TIFF, ZIP. ' +
                'Max 50 MB, max 10 pages per PDF, TIFF. ' +
                'Provide either "flow" (a configured flow name) or "flowId" (a raw Graip flow ID), but not both. ' +
                'If neither is provided, the default flow ID from the X-Graip-Flow-Id header is used. ' +
                'File source (exactly one required): ' +
                '1) "localFilePath" – absolute path to a file on the server machine (preferred for large files). ' +
                '2) "fileUrl" – a publicly accessible URL; the file will be downloaded automatically. ' +
                '3) "fileBase64" + "fileName" – base64-encoded content (⚠ only suitable for small files, ~1 MB or less).',
            inputSchema: {
                flow: z.string().optional()
                    .describe('Name of a configured flow (e.g. "invoices"). Mutually exclusive with flowId.'),
                flowId: z.string().optional()
                    .describe('Raw Graip.AI flow ID. Mutually exclusive with flow.'),
                localFilePath: z.string().optional()
                    .describe('Absolute path to a local file on the server, e.g. "/home/user/docs/invoice.pdf". Preferred for large files.'),
                fileUrl: z.string().optional()
                    .describe('Publicly accessible URL to download the file from, e.g. "https://example.com/invoice.pdf".'),
                fileBase64: z.string().optional()
                    .describe('Base64-encoded file content. ⚠ Only suitable for small files (~5 MB or less). Must be used together with fileName.'),
                fileName: z.string().optional()
                    .describe('File name (including extension) when using fileBase64, e.g. "invoice.pdf".'),
                title: z.string().optional()
                    .describe('Custom title to override the original file name'),
                pagesToProcess: z.string().optional()
                    .describe('Comma-separated list of pages/ranges, e.g. "1,2-4,5,-1"'),
                persistData: z.boolean().optional()
                    .describe('Whether to persist data after extraction (default: true)'),
            },
        },
        async ({ flow, flowId: rawFlowId, localFilePath, fileUrl, fileBase64, fileName, title, pagesToProcess, persistData }): Promise<CallToolResult> => {
            // --- Resolve flow ID ---
            if (flow && rawFlowId) {
                return {
                    content: [{ type: 'text', text: 'Provide either "flow" or "flowId", not both.' }],
                    isError: true,
                };
            }
            if (!flow && !rawFlowId) {
                if (headerFlowId) {
                    rawFlowId = headerFlowId;
                } else {
                    return {
                        content: [{ type: 'text', text: 'Either "flow" (configured name), "flowId" (raw ID), or the X-Graip-Flow-Id header is required.' }],
                        isError: true,
                    };
                }
            }

            let resolvedFlowId: string;
            if (flow) {
                try {
                    resolvedFlowId = resolveFlowId(flow);
                } catch (error) {
                    return {
                        content: [{ type: 'text', text: (error as Error).message }],
                        isError: true,
                    };
                }
            } else {
                resolvedFlowId = rawFlowId!;
            }

            // --- Resolve file source ---
            const sourceCount = [localFilePath, fileUrl, fileBase64].filter(Boolean).length;
            if (sourceCount === 0) {
                return {
                    content: [{ type: 'text', text: 'A file source is required. Provide exactly one of: "localFilePath", "fileUrl", or "fileBase64" + "fileName".' }],
                    isError: true,
                };
            }
            if (sourceCount > 1) {
                return {
                    content: [{ type: 'text', text: 'Provide only one file source: "localFilePath", "fileUrl", or "fileBase64" + "fileName".' }],
                    isError: true,
                };
            }

            let fileBuffer: Buffer;
            let resolvedFileName: string;
            const warnings: string[] = [];

            try {
                if (localFilePath) {
                    // --- Local file path ---
                    const resolvedPath = path.resolve(localFilePath);
                    const extCheck = validateExtension(resolvedPath);
                    if (!extCheck.ok) {
                        return { content: [{ type: 'text', text: extCheck.error }], isError: true };
                    }
                    if (!fs.existsSync(resolvedPath)) {
                        return { content: [{ type: 'text', text: `File not found: ${resolvedPath}` }], isError: true };
                    }
                    fileBuffer = fs.readFileSync(resolvedPath);
                    resolvedFileName = title || path.basename(resolvedPath);
                } else if (fileUrl) {
                    // --- Download from URL ---
                    const downloaded = await downloadFile(fileUrl);
                    const extCheck = validateExtension(downloaded.fileName);
                    if (!extCheck.ok) {
                        return { content: [{ type: 'text', text: extCheck.error }], isError: true };
                    }
                    fileBuffer = downloaded.buffer;
                    resolvedFileName = title || downloaded.fileName;
                } else {
                    // --- Base64 ---
                    if (!fileName) {
                        return { content: [{ type: 'text', text: '"fileName" is required when using "fileBase64".' }], isError: true };
                    }
                    const extCheck = validateExtension(fileName);
                    if (!extCheck.ok) {
                        return { content: [{ type: 'text', text: extCheck.error }], isError: true };
                    }
                    fileBuffer = Buffer.from(fileBase64!, 'base64');
                    resolvedFileName = title || fileName;
                    if (fileBuffer.length > MAX_BASE64_WARNING_BYTES) {
                        warnings.push(
                            `⚠ Warning: The decoded file is ${(fileBuffer.length / (1024 * 1024)).toFixed(1)} MB. ` +
                            'base64 input is only recommended for small files (~1 MB or less). ' +
                            'For large files, prefer "localFilePath" or "fileUrl" instead.',
                        );
                    }
                }
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Failed to read file: ${(error as Error).message}` }],
                    isError: true,
                };
            }

            const extra: Record<string, string> = {};
            if (title) extra.title = title;
            if (pagesToProcess) extra.pagesToProcess = pagesToProcess;
            if (persistData !== undefined) extra.persistData = "true";

            try {
                const result = await graipUpload<GraipRequestWithData>(
                    apiKey,
                    `/v1/${resolvedFlowId}/request/extract`,
                    fileBuffer,
                    resolvedFileName,
                    extra,
                );

                const flowLabel = flow ?? resolvedFlowId;
                const lines = [
                    ...warnings,
                    `Extraction complete (flow: ${flowLabel})!`,
                    '',
                    `ID: ${result.id}`,
                    `Title: ${result.title}`,
                    `Status: ${result.status}`,
                    '',
                    'Extracted data:',
                    JSON.stringify(result.data, null, 2),
                ];

                return { content: [{ type: 'text', text: lines.join('\n') }] };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Extraction failed: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );

    return server;
};

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 7891;

const app = createMcpExpressApp();

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Map session ID → API key so we can pass it to the server
const sessionApiKeys: { [sessionId: string]: string } = {};

// MCP POST endpoint
const mcpPostHandler = async (req: Request, res: Response) => {
    try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // Extract API key from Authorization header
            const apiKey = extractApiKey(req);
            if (!apiKey) {
                res.status(401).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Unauthorized: Authorization header with Graip API key is required',
                    },
                    id: null,
                });
                return;
            }

            // Optional default flow ID from header
            const headerFlowId = req.headers['x-graip-flow-id'] as string | undefined;

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    console.log(`Session initialized: ${sid}`);
                    transports[sid] = transport;
                    sessionApiKeys[sid] = apiKey;
                },
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    delete transports[sid];
                    delete sessionApiKeys[sid];
                }
            };

            const server = getServer(apiKey, headerFlowId);
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    }
};

app.post('/mcp', mcpPostHandler);

// SSE stream handler
app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
});

// Session termination handler
app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
});

app.listen(MCP_PORT, (error) => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log(`Graip MCP Server listening on port ${MCP_PORT}`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down...');
    for (const sessionId in transports) {
        try {
            await transports[sessionId].close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing session ${sessionId}:`, error);
        }
    }
    process.exit(0);
});