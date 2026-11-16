# Context.dev

Use Context.dev for OpenCode's native `websearch` and `webfetch` tools without loading an MCP server or additional tools. This plugin requires OpenCode V2.

## Setup

Set `CONTEXT_API_KEY` in the environment that runs the OpenCode server, or connect Context.dev using `/connect`. Keep the key out of project configuration.

Add this plugin's directory to `opencode.jsonc` while reviewing this checkout:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode/packages/plugins/context"],
  "websearch": { "provider": "context" },
}
```

The plugin registers Context.dev as a search provider and replaces `webfetch`. The `websearch` setting selects Context.dev; omit it to keep your existing selection or choose a provider from OpenCode's search settings. Removing the plugin and this setting restores the built-in fetch and previous search configuration. The plugin is not loaded automatically.

## Search and read

`websearch` returns up to eight results with query-relevant Highlights. When Highlights are unavailable, it retains the result's search description. These are search results, not a guarantee that every page was read live.

`webfetch` keeps the existing `url`, `format`, and `timeout` arguments. Markdown remains the default; `text` and `html` remain available. For focused reading, use `format: "highlights"` and describe what to find in `query`:

```json
{
  "url": "https://example.com/docs",
  "format": "highlights",
  "query": "How do I configure retries?"
}
```

Use `format: "markdown"` when the agent needs the whole page or complete examples. Empty Highlights are reported without silently fetching another format. Failed outputs remain tool errors even when the API returns HTTP 200.

Requests go directly to `api.context.dev` with the key in an authentication header. Public search queries and requested URLs are sent to Context.dev and use the account's credits and configured data policies. This plugin does not enable zero data retention or make a benchmark performance claim.

OpenCode checks `webfetch` permission for the requested URL before dispatch and any reported final URL before returning content. Context handles retrieval and redirects remotely; local rules cannot inspect every intermediate redirect. Configure Context access policies on the API key for server-enforced domain restrictions. The plugin does not fall back to direct HTTP or another provider when Context fails.
