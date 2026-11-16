# Context.dev

Use Context.dev for OpenCode's native `webfetch` tool, with focused Highlights and full-page scraping. The plugin calls Context's REST API directly. This plugin requires OpenCode V2.

## Setup

Set `CONTEXT_API_KEY` in the environment that runs the OpenCode server, or connect Context.dev using `/connect`. Keep the key out of project configuration.

Add this plugin's directory to `opencode.jsonc` while reviewing this checkout:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode/packages/plugins/context"],
}
```

Installing the plugin replaces `webfetch`. It does not register a search provider, change `websearch`, or load an MCP server. Your existing search integration can find URLs, and this plugin reads them. Removing the plugin restores the built-in fetch. The plugin is not loaded automatically.

## Read a page

`webfetch` keeps the existing `url`, `format`, and `timeout` arguments. Markdown remains the default; `text` and `html` remain available. For focused reading, use `format: "highlights"` and describe what to find in `query`:

```json
{
  "url": "https://example.com/docs",
  "format": "highlights",
  "query": "How do I configure retries?"
}
```

Use `format: "markdown"` when the agent needs the whole page or complete examples. Empty Highlights are reported without silently fetching another format. Failed outputs remain tool errors even when the API returns HTTP 200.

Requests go directly to `api.context.dev` with the key in an authentication header. Requested URLs and any Highlights query are sent to Context.dev and use the account's credits and configured data policies. This plugin does not enable zero data retention or make a benchmark performance claim.

OpenCode checks `webfetch` permission for the requested URL before dispatch and any reported final URL before returning content. Context handles retrieval and redirects remotely; local rules cannot inspect every intermediate redirect. Configure Context access policies on the API key for server-enforced domain restrictions. The plugin does not fall back to direct HTTP or another provider when Context fails.
