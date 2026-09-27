import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

describe("audio Worker API", () => {
	it("reports that analysis runs in Worker WASM", async () => {
		const request = new Request("http://example.com/api/health");
		const response = await worker.fetch(request, env, createExecutionContext());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, app: "yoin", processing: "worker-wasm", wasmReady: true });
	});

	it("rejects inconsistent upload metadata before creating a job", async () => {
		const request = new Request("http://example.com/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileBytes: 80, dataOffset: 44, dataBytes: 32, frames: 5, channels: 2, fileName: "test.wav" }),
		});
		const response = await worker.fetch(request, env, createExecutionContext());

		expect(response.status).toBe(413);
	});
});
