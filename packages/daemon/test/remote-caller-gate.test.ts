import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { remoteCallerGate, isLoopbackRequest } from "../src/middleware/auth-bearer-token.js";

function app(token: string | null) {
  const a = new Hono();
  a.use("*", remoteCallerGate(token));
  a.get("/healthz", (c) => c.text("ok"));
  a.get("/", (c) => c.html(isLoopbackRequest(c) ? "<html>token</html>" : "<html></html>"));
  a.get("/api/rigs", (c) => c.text("rigs"));
  a.post("/api/transport/send", (c) => c.text("sent"));
  return a;
}
const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
const send = (a: Hono, addr: string, auth?: string) =>
  a.request("/api/transport/send", { method: "POST", headers: auth ? { Authorization: auth } : {} }, from(addr));

describe("remoteCallerGate", () => {
  it("lets callers on this host through without a token", async () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect((await send(app(null), addr)).status).toBe(200);
  });
  it("refuses remote callers when no bearer is configured, even on a tailnet", async () => {
    expect((await send(app(null), "100.101.102.103")).status).toBe(401);
    expect((await app(null).request("/healthz", {}, from("100.101.102.103"))).status).toBe(200);
  });
  it("requires the exact bearer from remote callers", async () => {
    expect((await send(app("s3cret"), "192.168.1.5")).status).toBe(401);
    expect((await send(app("s3cret"), "192.168.1.5", "Bearer wrong")).status).toBe(401);
    expect((await send(app("s3cret"), "192.168.1.5", "Bearer s3cret")).status).toBe(200);
  });
  it("treats a socketless in-process request as local", () => {
    expect(isLoopbackRequest({})).toBe(true);
    expect(isLoopbackRequest({ env: from("10.0.0.2") })).toBe(false);
  });
  it("treats a same-host reverse proxy as remote", async () => {
    const proxied = await app(null).request("/api/transport/send", { method: "POST", headers: { "X-Forwarded-For": "203.0.113.9" } }, from("127.0.0.1"));
    expect(proxied.status).toBe(401);
    const page = await app(null).request("/", { headers: { Forwarded: "for=203.0.113.9" } }, from("127.0.0.1"));
    expect(await page.text()).toBe("<html></html>");
  });
  it("serves the static shell publicly but gates every API read", async () => {
    expect((await app("s3cret").request("/", {}, from("192.168.1.5"))).status).toBe(200);
    expect((await app("s3cret").request("/api/rigs", {}, from("192.168.1.5"))).status).toBe(401);
  });
});
