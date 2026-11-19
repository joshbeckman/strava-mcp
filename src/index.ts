/**
 * Strava MCP relay.
 *
 * Strava's MCP server (https://mcp.strava.com/mcp) holds the only source of
 * strength-training set data: exercise names, weights, reps, durations and
 * muscle groups. Its OAuth registration only permits loopback redirects, so a
 * Worker can never receive the authorization code. This Worker therefore owns
 * the *tokens*, not the login: one bootstrap call seeds a refresh token, and
 * the Worker refreshes it forever after.
 *
 * Every route requires `Authorization: Bearer <SHARED_SECRET>`.
 *
 * Tokens live in a single Durable Object instance. That matters: Strava rotates
 * the refresh token on every use, so two concurrent refreshes would invalidate
 * each other and force a manual re-bootstrap. A DO serializes them.
 */

const MCP_URL = "https://mcp.strava.com/mcp";
const TOKEN_URL = "https://www.strava.com/oauth/mcp/token";
const CLIENT_ID = "248572";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface Env {
  SHARED_SECRET: string;
  TOKENS: DurableObjectNamespace;
}

type Tokens = {
  access_token: string;
  access_expires: number;
  refresh_token: string;
};

/** Single-writer token store. */
export class TokenStore {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/get") return this.get();
    if (url.pathname === "/seed") return this.seed(request);
    return new Response("not found", { status: 404 });
  }

  private async seed(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<Tokens>;
    if (!body.refresh_token) {
      return new Response("refresh_token required", { status: 400 });
    }
    const tokens: Tokens = {
      access_token: body.access_token ?? "",
      access_expires: body.access_expires ?? 0,
      refresh_token: body.refresh_token,
    };
    await this.state.storage.put("tokens", tokens);
    return Response.json({ seeded: true, has_access: !!tokens.access_token });
  }

  private async get(): Promise<Response> {
    const tokens = await this.state.storage.get<Tokens>("tokens");
    if (!tokens) return new Response("no tokens seeded", { status: 409 });
    const now = Math.floor(Date.now() / 1000);
    if (tokens.access_token && tokens.access_expires - 120 > now) {
      return Response.json({ access_token: tokens.access_token });
    }
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!res.ok) {
      return new Response(`refresh failed: ${await res.text()}`, { status: 502 });
    }
    const payload = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    const next: Tokens = {
      access_token: payload.access_token,
      access_expires: now + (payload.expires_in ?? 3600),
      // Strava rotates the refresh token on every refresh; keep the new one.
      refresh_token: payload.refresh_token ?? tokens.refresh_token,
    };
    await this.state.storage.put("tokens", next);
    return Response.json({ access_token: next.access_token });
  }
}

function stub(env: Env) {
  return env.TOKENS.get(env.TOKENS.idFromName("strava-mcp"));
}

async function accessToken(env: Env): Promise<string> {
  const res = await stub(env).fetch("https://do/get");
  if (res.status !== 200) {
    throw new Error(`token store: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

function authorized(request: Request, env: Env): boolean {
  const given = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.SHARED_SECRET}`;
  if (!env.SHARED_SECRET || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

/** One JSON-RPC round trip against the MCP server. */
async function mcp(env: Env, method: string, params?: unknown): Promise<unknown> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method };
  if (params !== undefined) body.params = params;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The MCP server streams or returns JSON; accept both.
      Accept: "application/json, text/event-stream",
      "User-Agent": UA,
      Authorization: `Bearer ${await accessToken(env)}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`mcp ${method}: ${res.status} ${text.slice(0, 300)}`);
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

/** Tool results arrive as text blocks; unwrap the JSON payload when present. */
function unwrap(result: unknown): unknown {
  const content =
    (result as { result?: { content?: { type: string; text?: string }[] } })
      ?.result?.content ?? [];
  const text = content.find((c) => c.type === "text")?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * The MCP server reports rate limiting inside a successful JSON-RPC response,
 * as a single non-JSON text block. Surface it as 429 so callers back off
 * instead of recording an empty result.
 */
function failure(value: unknown): { status: number; message: string } | null {
  const text =
    value && typeof value === "object" && Object.keys(value).length === 1
      ? (value as { text?: string }).text
      : undefined;
  if (typeof text !== "string") return null;
  return { status: /rate limit/i.test(text) ? 429 : 502, message: text };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        const token = await accessToken(env);
        return json({ ok: true, token_preview: `${token.slice(0, 4)}...` });
      }
      if (url.pathname === "/bootstrap" && request.method === "POST") {
        const body = await request.json();
        const res = await stub(env).fetch("https://do/seed", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return json(await res.json(), res.status);
      }
      if (url.pathname === "/tools") {
        return json(unwrap(await mcp(env, "tools/list")));
      }
      if (url.pathname === "/call" && request.method === "POST") {
        const { tool, arguments: args } = (await request.json()) as {
          tool: string;
          arguments?: unknown;
        };
        if (!tool) return json({ error: "tool required" }, 400);
        const value = unwrap(
          await mcp(env, "tools/call", { name: tool, arguments: args ?? {} }),
        );
        const bad = failure(value);
        if (bad) return json({ error: bad.message }, bad.status);
        return json(value);
      }
      // Convenience route for the site build: sets for one or more activities.
      if (url.pathname === "/strength") {
        const ids = (url.searchParams.get("ids") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        if (!ids.length) return json({ error: "ids required" }, 400);
        const value = unwrap(
          await mcp(env, "tools/call", {
            name: "get_strength_workout_details",
            arguments: { activity_ids: ids },
          }),
        );
        const bad = failure(value);
        if (bad) return json({ error: bad.message }, bad.status);
        return json(value);
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 502);
    }
  },
};
