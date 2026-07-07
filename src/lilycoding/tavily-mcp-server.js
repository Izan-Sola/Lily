// tavily-mcp-server.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import axios from "axios"

const TAVILY_API_KEY = process.env.TAVILY_API_KEY

const server = new McpServer({
    name: "tavily-search",
    version: "1.0.0",
})

server.tool(
    "search_web",
    "Search the web using Tavily",
    {
        query: z.string().describe("The search query"),
    },
    async ({ query }) => {
        try {
            const { data } = await axios.post("https://api.tavily.com/search", {
                api_key: TAVILY_API_KEY,
                query,
                max_results: 2,
                include_images: true,
            })

            const results = (data.results ?? []).map(r => ({
                title: r.title,
                url: r.url,
                snippet: r.content,
            }))

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ results, images: data.images ?? [] }, null, 2),
                    },
                ],
            }
        } catch (err) {
            return {
                content: [{ type: "text", text: `Error: ${err.message}` }],
                isError: true,
            }
        }
    }
)

const transport = new StdioServerTransport()
await server.connect(transport)