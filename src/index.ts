/// <reference path="../worker-configuration.d.ts" />

import {
  DurableObject
} from "cloudflare:workers";

const MAX_BODY_BYTES = 1_048_576;
const STARTUP_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const COORDINATOR_NAME = "painless-origin";
const GITHUB_API_VERSION = "2026-03-10";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

type StartupState = {
  status: "idle" | "starting" | "ready";
  startedAt ? : number;
  readyAt ? : number;
};

type WorkflowRunsResponse = {
  workflow_runs ? : Array < {
    status ? : string
  } > ;
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonError(error: string, status: number): Response {
  return withCors(Response.json({
    error
  }, {
    status
  }));
}

function originHeaders(env: Env): Headers {
  return new Headers({
    "CF-Access-Client-Id": env.ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET,
  });
}

async function verifyToken(provided: string, expected: string): Promise < boolean > {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

async function readLimitedBody(request: Request): Promise < ArrayBuffer | null > {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length <= 0 || length > MAX_BODY_BYTES) return null;
  }
  if (!request.body) return null;

  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request.body) {
    length += chunk.byteLength;
    if (length > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  if (length === 0) return null;

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export class TunnelCoordinator extends DurableObject < Env > {
  async ensureReady(): Promise < boolean > {
    if (await this.probeOrigin()) {
      await this.setState({
        status: "ready",
        readyAt: Date.now()
      });
      return true;
    }

    const now = Date.now();
    const state = await this.getState();
    let startedAt = state.startedAt;
    if (state.status !== "starting" || !startedAt || now - startedAt >= STARTUP_TIMEOUT_MS) {
      startedAt = now;
      await this.setState({
        status: "starting",
        startedAt
      });
      try {
        if (!(await this.hasActiveWorkflow())) await this.dispatchWorkflow();
      } catch (error) {
        await this.setState({
          status: "idle"
        });
        console.error(JSON.stringify({
          message: "workflow startup failed",
          error: String(error)
        }));
        throw error;
      }
    }

    const deadline = startedAt + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await scheduler.wait(POLL_INTERVAL_MS);
      if (await this.probeOrigin()) {
        await this.setState({
          status: "ready",
          readyAt: Date.now()
        });
        return true;
      }
    }

    await this.setState({
      status: "idle"
    });
    return false;
  }

  async markReady(): Promise < void > {
    const state = await this.getState();
    await this.setState({
      status: "starting",
      startedAt: state.startedAt ?? Date.now(),
      readyAt: Date.now(),
    });
  }

  private async getState(): Promise < StartupState > {
    return (await this.ctx.storage.get < StartupState > ("startup")) ?? {
      status: "idle"
    };
  }

  private async setState(state: StartupState): Promise < void > {
    await this.ctx.storage.put("startup", state);
  }

  private async probeOrigin(): Promise < boolean > {
    try {
      const response = await fetch(new URL("/", this.env.ORIGIN_URL), {
        headers: originHeaders(this.env),
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private githubHeaders(): Headers {
    return new Headers({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "painless-runner-worker",
    });
  }

  private workflowUrl(suffix: string): URL {
    return new URL(
      `https://api.github.com/repos/${this.env.GITHUB_OWNER}/${this.env.GITHUB_REPO}/actions/workflows/${this.env.GITHUB_WORKFLOW}${suffix}`,
    );
  }

  private async hasActiveWorkflow(): Promise < boolean > {
    const url = this.workflowUrl("/runs");
    url.searchParams.set("branch", this.env.GITHUB_REF);
    url.searchParams.set("event", "workflow_dispatch");
    url.searchParams.set("per_page", "10");
    const response = await fetch(url, {
      headers: this.githubHeaders()
    });
    if (!response.ok) throw new Error(`GitHub workflow lookup failed with ${response.status}`);
    const data = await response.json < WorkflowRunsResponse > ();
    const activeStatuses = new Set(["requested", "waiting", "pending", "queued", "in_progress"]);
    return data.workflow_runs?.some(({
      status
    }) => status !== undefined && activeStatuses.has(status)) ?? false;
  }

  private async dispatchWorkflow(): Promise < void > {
    const response = await fetch(this.workflowUrl("/dispatches"), {
      method: "POST",
      headers: this.githubHeaders(),
      body: JSON.stringify({
        ref: this.env.GITHUB_REF,
        inputs: {
          callback_token: this.env.CALLBACK_TOKEN,
          tunnel_token: this.env.CLOUDFLARE_TUNNEL_TOKEN,
          worker_callback_url: this.env.WORKER_CALLBACK_URL,
        },
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`GitHub workflow dispatch failed with ${response.status}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise < Response > {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, {
        status: 204
      }));
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(Response.json({
        status: "ok"
      }));
    }

    const coordinator = env.TUNNEL_COORDINATOR.getByName(COORDINATOR_NAME);
    if (request.method === "POST" && url.pathname === "/_internal/tunnel-ready") {
      if (!(await verifyToken(bearerToken(request), env.CALLBACK_TOKEN))) return jsonError("unauthorized", 401);
      await coordinator.markReady();
      return withCors(Response.json({
        status: "ready"
      }));
    }

    if (request.method !== "POST" || url.pathname !== "/execute") {
      return jsonError("not found", 404);
    }

    const body = await readLimitedBody(request);
    if (!body) return jsonError(`body must be between 1 and ${MAX_BODY_BYTES} bytes`, 413);

    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      return jsonError("body must be valid JSON", 400);
    }

    try {
      if (!(await coordinator.ensureReady())) return jsonError("Elasticsearch startup timed out", 503);

      const headers = originHeaders(env);
      headers.set("Content-Type", "application/json");
      const response = await fetch(new URL("/_scripts/painless/_execute", env.ORIGIN_URL), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
      });
      return withCors(new Response(response.body, response));
    } catch (error) {
      console.error(JSON.stringify({
        message: "origin startup or request failed",
        error: String(error)
      }));
      return jsonError("Elasticsearch is unavailable", 502);
    }
  },
}
satisfies ExportedHandler < Env > ;
