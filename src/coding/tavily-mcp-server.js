// tavily-mcp-server.js
//
// Tavily search as an MCP server.
//   stdio (default):  node tavily-mcp-server.js
//   HTTP (remote):    MCP_HTTP_PORT=8769 node tavily-mcp-server.js
// HTTP mode lets Continue on other devices use it via a URL, so the API key
// stays on the minipc. Set MCP_AUTH_TOKEN to require a bearer token.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import axios from "axios"
import express from "express"

const TAVILY_API_KEY = process.env.TAVILY_API_KEY
if (!TAVILY_API_KEY) {
    console.error("TAVILY_API_KEY is not set")
    process.exit(1)
}

async function tavily({ query, maxResults, includeImages }) {
    try {
        const { data } = await axios.post(
            "https://api.tavily.com/search",
            {
                query,
                max_results: maxResults,
                include_images: includeImages,
                include_image_descriptions: includeImages,
            },
            {
                headers: { Authorization: `Bearer ${TAVILY_API_KEY}` },
                timeout: 20_000,
            }
        )
        const results = (data.results ?? []).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
        }))
        const payload = includeImages ? { results, images: data.images ?? [] } : { results }
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
    } catch (err) {
        const detail = err.response?.data?.detail?.error ?? err.response?.data?.error ?? err.message
        return { content: [{ type: "text", text: `Error: ${detail}` }], isError: true }
    }
}

function buildServer() {
    const server = new McpServer({ name: "tavily-search", version: "1.1.0" })

    server.tool(
        "web_search",
        "Search the web using Tavily. Returns titles, URLs and snippets.",
        {
            query: z.string().describe("The search query"),
            max_results: z.number().int().min(1).max(10).default(5).describe("Number of results"),
        },
        ({ query, max_results }) => tavily({ query, maxResults: max_results, includeImages: false })
    )

    // Kept under its old name so existing callers don't break.
    server.tool(
        "image_search",
        "Search the web using Tavily and also return relevant image URLs.",
        { query: z.string().describe("The search query") },
        ({ query }) => tavily({ query, maxResults: 3, includeImages: true })
    )

    return server
}

const httpPort = Number(process.env.MCP_HTTP_PORT)

if (httpPort) {
    const app = express()
    app.use(express.json())

    app.use((req, res, next) => {
        const token = process.env.MCP_AUTH_TOKEN
        if (!token || req.headers.authorization === `Bearer ${token}`) return next()
        res.status(401).json({ error: "unauthorized" })
    })

    // Stateless mode: a fresh server + transport per request.
    app.post("/mcp", async (req, res) => {
        const server = buildServer()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on("close", () => { transport.close(); server.close() })
        try {
            await server.connect(transport)
            await transport.handleRequest(req, res, req.body)
        } catch (err) {
            if (!res.headersSent) res.status(500).json({ error: err.message })
        }
    })
    app.all("/mcp", (_req, res) => res.status(405).json({ error: "use POST" }))

    app.listen(httpPort, process.env.MCP_HOST || "0.0.0.0", () =>
        console.error(`tavily MCP on http://0.0.0.0:${httpPort}/mcp`))
} else {
    await buildServer().connect(new StdioServerTransport())
}