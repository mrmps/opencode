import { beforeEach, describe, expect } from "bun:test"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Integration } from "@opencode/core/integration"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginModule } from "@opencode/core/plugin/module"
import { Tool } from "@opencode/core/tool"
import { WebFetchTool } from "@opencode/core/tool/plugin/webfetch"
import { WebSearchTool } from "@opencode/core/tool/plugin/websearch"
import { WebSearch } from "@opencode/core/websearch"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"
import { makePluginTestLayer } from "./fixture"

ensurePluginRuntime()

const key = "context-acceptance-secret"
const url = "https://docs.example.com/retries"
const assertions: Permission.AssertInput[] = []
const denied = new Set<string>()
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.resources.some((resource) => denied.has(resource))
            ? Effect.fail(
                new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
              )
            : Effect.void,
        ),
      ),
    assertNotDenied: () => Effect.void,
    allows: () => Effect.succeed(true),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const it = testEffect(makePluginTestLayer(permission))

beforeEach(() => {
  assertions.length = 0
  denied.clear()
})

// Native registry -> public plugin loader/host -> HTTP transport -> local API server.
// Only the transport origin changes; no Context API endpoint option or global fetch mock is used.
const setup = Effect.fn(function* (body: unknown = {}, status = 200, pending = false, activate = true) {
  const requests: { path: string; headers: Headers; body: unknown }[] = []
  const started = yield* Deferred.make<void>()
  const signals: AbortSignal[] = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.json() })
          Effect.runSync(Deferred.succeed(started, undefined))
          if (pending) return new Promise<Response>(() => {})
          return new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          })
        },
      }),
    ),
    (server) => Effect.sync(() => server.stop(true)),
  )
  const http = HttpClient.make((request, _url, signal) =>
    Effect.gen(function* () {
      expect(new URL(request.url).origin).toBe("https://api.context.dev")
      expect(request.method).toBe("POST")
      expect(request.body._tag).toBe("Uint8Array")
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON request")
      const body = request.body.body
      signals.push(signal)
      const response = yield* Effect.promise(() =>
        fetch(new URL(new URL(request.url).pathname, server.url), {
          method: request.method,
          headers: request.headers,
          body,
          signal,
        }),
      )
      return HttpClientResponse.fromWeb(request, response)
    }),
  )
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.CONTEXT_API_KEY
      process.env.CONTEXT_API_KEY = key
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.CONTEXT_API_KEY
        else process.env.CONTEXT_API_KEY = previous
      }),
  )
  const plugins = yield* Plugin.Service
  const host = yield* PluginHost.make(plugins, "opencode.context")
  yield* WebFetchTool.Plugin.effect(host)
  yield* WebSearchTool.Plugin.effect(host)
  const tools = yield* Tool.Service
  const before = yield* tools.list()
  const websearch = yield* WebSearch.Service
  yield* websearch.transform((editor) =>
    editor.add({
      id: WebSearch.ID.make("existing"),
      name: "Existing search",
      execute: () => Effect.succeed([{ url, content: "Existing provider result", time: {} }]),
    }),
  )
  yield* websearch.select(WebSearch.ID.make("existing"))
  const beforeSearch = yield* websearch.providers()
  const modules = yield* PluginModule.make()
  const loaded = yield* modules.load({
    type: "add",
    target: path.resolve(import.meta.dir, "../../../plugins/context"),
    options: {},
  })
  if (!("effect" in loaded) || !loaded.effect) return yield* Effect.die("Context plugin did not load")
  expect(loaded.id).toBe("opencode.context")
  if (activate) {
    yield* loaded.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  }
  return { tools, before, websearch, beforeSearch, requests, started, signals }
})

const call = (tools: Tool.Interface, name: string, input: unknown) =>
  executeTool(tools, {
    sessionID: Session.ID.make("ses_context_acceptance"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_context_acceptance"),
    call: { type: "tool-call", id: "call_context_acceptance", name, input },
  })

const scraped = (format: string, data: string | string[]) => ({
  url,
  [format]: { requested: true, success: true, data },
  metadata: { title: "Retries", finalUrl: url },
})

describe("Context OpenCode acceptance", () => {
  it.live("baseline native webfetch does not support focused Highlights", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({}, 200, false, false)
      const output = yield* call(fixture.tools, "webfetch", { url, format: "highlights", query: "configure retries" })
      expect(output.status).toBe("error")
      expect(fixture.requests).toHaveLength(0)
    }),
  )

  it.live("loads the scraping plugin without adding tools or changing web search", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(scraped("markdown", "# Page content"))
      expect((yield* fixture.tools.list()).map((tool) => tool.name)).toEqual(fixture.before.map((tool) => tool.name))
      expect(yield* fixture.websearch.providers()).toEqual(fixture.beforeSearch)
      expect(yield* fixture.websearch.default()).toEqual({ id: WebSearch.ID.make("existing"), name: "Existing search" })
      const search = yield* call(fixture.tools, "websearch", { query: "configure retries" })
      expect(search.status).toBe("completed")
      expect(JSON.stringify(search)).toContain("Existing provider result")
      expect(fixture.requests).toHaveLength(0)
      const integrations = yield* Integration.Service
      expect(yield* integrations.get(Integration.ID.make("context"))).toMatchObject({
        name: "Context.dev",
        methods: [{ type: "key" }, { type: "env", names: ["CONTEXT_API_KEY"] }],
      })
      const output = yield* call(fixture.tools, "webfetch", { url })
      expect(output.status).toBe("completed")
      expect(JSON.stringify(output)).toContain("# Page content")
      expect(JSON.stringify(output)).not.toContain(key)
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.requests[0]?.path).toBe("/v1/web/scrape")
      expect(fixture.requests[0]?.headers.get("authorization")).toBe(`Bearer ${key}`)
    }),
  )

  for (const entry of [
    { format: "markdown", data: "# Retries\n\n```ts\nretries: 3\n```", expected: "```ts\nretries: 3\n```" },
    { format: "html", data: "<h1>Retries</h1><p>Set retries to 3.</p>", expected: "<h1>Retries</h1>" },
    { format: "text", data: "<h1>Retries</h1><p>Set retries to 3.</p>", expected: "Set retries to 3." },
    { format: "highlights", data: ["Set retries to 3."], expected: "Set retries to 3." },
  ]) {
    it.live(`dispatches native webfetch in ${entry.format} format`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup(scraped(entry.format === "text" ? "html" : entry.format, entry.data))
        const output = yield* call(fixture.tools, "webfetch", {
          url,
          format: entry.format,
          ...(entry.format === "highlights" ? { query: "configure retries" } : {}),
        })
        expect(output.status).toBe("completed")
        expect(JSON.stringify(output)).toContain(entry.expected.replaceAll("\n", "\\n"))
        expect(JSON.stringify(output)).not.toContain(key)
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.path).toBe("/v1/web/scrape")
        expect(fixture.requests[0]?.body).toEqual({
          url,
          formats: { [entry.format === "text" ? "html" : entry.format]: true },
          ...(entry.format === "highlights" ? { highlightsParams: { query: "configure retries" } } : {}),
          timeoutOpts: { milliseconds: 30_000, behavior: "fail" },
        })
        expect(
          assertions.some((assertion) => assertion.action === "webfetch" && assertion.resources.includes(url)),
        ).toBe(true)
      }),
    )
  }

  it.live("retains Markdown as the default and rejects Highlights without a query before network", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(scraped("markdown", "# Full documentation"))
      expect((yield* call(fixture.tools, "webfetch", { url })).status).toBe("completed")
      expect((yield* call(fixture.tools, "webfetch", { url, format: "highlights" })).status).toBe("error")
      expect(fixture.requests).toHaveLength(1)
    }),
  )

  it.live("enforces URL permissions before sending a request", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(scraped("markdown", "secret"))
      denied.add(url)
      expect((yield* call(fixture.tools, "webfetch", { url })).status).toBe("error")
      expect(fixture.requests).toHaveLength(0)
    }),
  )

  it.live("requires a Context credential before network", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      delete process.env.CONTEXT_API_KEY
      expect((yield* call(fixture.tools, "webfetch", { url })).status).toBe("error")
      expect(fixture.requests).toHaveLength(0)
    }),
  )

  it.live("does not expose content from a denied final URL", () =>
    Effect.gen(function* () {
      const finalUrl = "https://private.example.com/redirected"
      const fixture = yield* setup({ ...scraped("markdown", "private redirected content"), metadata: { finalUrl } })
      denied.add(finalUrl)
      const output = yield* call(fixture.tools, "webfetch", { url })
      expect(output.status).toBe("error")
      expect(JSON.stringify(output)).not.toContain("private redirected content")
    }),
  )

  it.live("rejects credential-bearing and non-HTTP URLs before network", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(scraped("markdown", "unexpected"))
      for (const invalid of ["file:///etc/passwd", "https://user:password@example.com/private"]) {
        expect((yield* call(fixture.tools, "webfetch", { url: invalid })).status).toBe("error")
      }
      expect(fixture.requests).toHaveLength(0)
    }),
  )

  for (const format of ["markdown", "html", "text", "highlights"]) {
    it.live(`does not report HTTP 200 ${format} failures as successful page reads`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup({
          url,
          [format === "text" ? "html" : format]: {
            requested: true,
            success: false,
            error_code: "FETCH_FAILED",
            message: "blocked",
          },
        })
        const output = yield* call(fixture.tools, "webfetch", {
          url,
          format,
          ...(format === "highlights" ? { query: "configure retries" } : {}),
        })
        expect(output.status).toBe("error")
        expect(JSON.stringify(output)).not.toContain(key)
      }),
    )
  }

  for (const response of [
    { name: "HTTP authentication failure", body: { message: "Unauthorized" }, status: 401 },
    { name: "malformed JSON", body: "{broken", status: 200 },
    { name: "invalid scrape envelope", body: { markdown: "invalid" }, status: 200 },
  ]) {
    it.live(`reports scrape ${response.name} without leaking credentials`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup(response.body, response.status)
        const output = yield* call(fixture.tools, "webfetch", { url })
        expect(output.status).toBe("error")
        expect(JSON.stringify(output)).not.toContain(key)
      }),
    )
  }

  it.live("aborts the outbound scrape when the OpenCode call is cancelled", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({}, 200, true)
      const execution = yield* call(fixture.tools, "webfetch", { url }).pipe(
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Deferred.await(fixture.started)
      yield* Fiber.interrupt(execution)
      expect(Exit.hasInterrupts(yield* Fiber.await(execution))).toBe(true)
      expect(fixture.signals[0]?.aborted).toBe(true)
    }),
  )

  it.live("applies the native webfetch timeout to the remote request", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({}, 200, true)
      const result = yield* call(fixture.tools, "webfetch", { url, timeout: 0.05 })
      expect(result.status).toBe("error")
      expect(fixture.signals[0]?.aborted).toBe(true)
    }),
  )
})
