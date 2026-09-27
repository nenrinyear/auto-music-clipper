import { Hono } from "hono";
import { analyze_features, apply_gain, finish_analysis, measure_chunk_peak } from "./wasm/worker_wasm";

const RATE = 48_000;
const MAX_FRAMES = RATE * 60 * 120;
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const PROCESS_SECONDS = 30;
const PROCESS_FRAMES = RATE * PROCESS_SECONDS;
const HOP_FRAMES = 480;
const WINDOW_FRAMES = 2048;
const FEATURE_BYTES = 24;
const FEATURE_BINS = 1400;
const MAX_GAIN_DB = 24;
const JOB_PREFIX = "jobs/";

interface JobMeta {
	id: string;
	fileName: string;
	fileBytes: number;
	dataOffset: number;
	dataBytes: number;
	frames: number;
	channels: 1 | 2;
	partCount: number;
	status: "uploading" | "analyzing" | "ready" | "rendering" | "writing" | "complete" | "failed";
	progress: number;
	createdAt: number;
	analysisSegments: number;
	renderStart?: number;
	renderEnd?: number;
	renderSegments?: number;
	targetDb?: number;
	outputFrames?: number;
	outputParts?: number;
	gain?: number;
	normalize?: boolean;
	error?: string;
}

const app = new Hono<{ Bindings: Env }>();
app.get("/api/health", (c) => {
	return c.json({ ok: true, app: "yoin", processing: "worker-wasm", wasmReady: measure_chunk_peak(new Float32Array()) === 0 });
});

app.post("/api/jobs", async (c) => {
	const body: unknown = await c.req.json().catch(() => null);
	if (!isRecord(body)) return c.json({ error: "Invalid job metadata." }, 400);
	const { fileBytes, dataOffset, dataBytes, frames, channels, fileName } = body;
	if (!isPositiveInt(fileBytes) || !isPositiveInt(dataBytes) || !isPositiveInt(frames)
		|| !isPositiveInt(dataOffset) || ![1, 2].includes(Number(channels)) || typeof fileName !== "string") {
		return c.json({ error: "Invalid WAV metadata." }, 400);
	}
	const ch = Number(channels) as 1 | 2;
	if (frames > MAX_FRAMES || dataBytes !== frames * ch * 4 || dataOffset + dataBytes > fileBytes
		|| fileBytes > dataBytes + 16 * 1024 * 1024) {
		return c.json({ error: "WAV length exceeds the supported range or metadata is inconsistent." }, 413);
	}
	const id = crypto.randomUUID();
	const meta: JobMeta = {
		id,
		fileName: cleanFileName(fileName),
		fileBytes,
		dataOffset,
		dataBytes,
		frames,
		channels: ch,
		partCount: Math.ceil(fileBytes / UPLOAD_PART_BYTES),
		status: "uploading",
		progress: 0,
		createdAt: Date.now(),
		analysisSegments: Math.ceil(frames / PROCESS_FRAMES),
	};
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ jobId: id, chunkBytes: UPLOAD_PART_BYTES, partCount: meta.partCount }, 201);
});

app.put("/api/jobs/:id/input/:part", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	if (meta.status !== "uploading") return c.json({ error: "Upload is already closed." }, 409);
	const part = Number(c.req.param("part"));
	if (!Number.isInteger(part) || part < 0 || part >= meta.partCount) return c.json({ error: "Invalid part number." }, 400);
	const expected = Math.min(UPLOAD_PART_BYTES, meta.fileBytes - part * UPLOAD_PART_BYTES);
	if (!c.req.raw.body) return c.json({ error: "Upload part is empty." }, 400);
	const declaredLength = c.req.header("content-length");
	if (declaredLength && Number(declaredLength) !== expected) return c.json({ error: "Incorrect upload part size." }, 400);
	const partBytes = await c.req.arrayBuffer();
	if (partBytes.byteLength !== expected) return c.json({ error: "Incorrect upload part size." }, 400);
	await c.env.AUDIO_BUCKET.put(inputKey(meta.id, part), partBytes, {
		httpMetadata: { contentType: "application/octet-stream" },
	});
	return c.body(null, 204);
});

app.post("/api/jobs/:id/analyze", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	if (meta.status !== "uploading") return c.json({ error: "Job analysis has already started." }, 409);
	const headerBytes = await readFileRange(c.env.AUDIO_BUCKET, meta, 0, Math.min(meta.fileBytes, 1024 * 1024));
	const parsed = parseWaveHeader(headerBytes, meta.fileBytes);
	if (parsed.channels !== meta.channels || parsed.frames !== meta.frames || parsed.dataOffset !== meta.dataOffset) return c.json({ error: "WAV metadata does not match the uploaded file." }, 400);
	const uploaded = await c.env.AUDIO_BUCKET.list({ prefix: inputPrefix(meta.id), limit: 1000 });
	if (uploaded.objects.length !== meta.partCount) return c.json({ error: "Some upload parts are missing." }, 409);
	meta.status = "analyzing";
	meta.progress = 0;
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ jobId: meta.id, status: meta.status, segments: meta.analysisSegments }, 202);
});

app.post("/api/jobs/:id/analyze/segment/:segment", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	const index = Number(c.req.param("segment"));
	if (meta.status !== "analyzing" || !Number.isInteger(index) || index < 0 || index >= meta.analysisSegments) return c.json({ error: "Invalid analysis segment." }, 409);
	const keepStart = index * PROCESS_FRAMES;
	const keepEnd = Math.min(meta.frames, keepStart + PROCESS_FRAMES);
	const sourceStart = Math.max(0, keepStart - HOP_FRAMES);
	const sourceEnd = Math.min(meta.frames, keepEnd + WINDOW_FRAMES + HOP_FRAMES);
	const samples = toSamples(await readPcmFrames(c.env.AUDIO_BUCKET, meta, sourceStart, sourceEnd));
	const features = analyze_features(samples, meta.channels, sourceStart, keepStart, keepEnd);
	await c.env.AUDIO_BUCKET.put(featureKey(meta.id, index), features);
	meta.progress = Math.round(((index + 1) / meta.analysisSegments) * 90);
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ segment: index, complete: index + 1, total: meta.analysisSegments, featureBytes: features.byteLength });
});

app.post("/api/jobs/:id/analyze/finish", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	if (meta.status !== "analyzing") return c.json({ error: "Job is not being analyzed." }, 409);
	let featureBytes = 0;
	for (let index = 0; index < meta.analysisSegments; index++) {
		const object = await c.env.AUDIO_BUCKET.head(featureKey(meta.id, index));
		if (!object) return c.json({ error: `Analysis segment ${index} is missing.` }, 409);
		featureBytes += object.size;
	}
	const packed = new Uint8Array(featureBytes);
	let position = 0;
	for (let index = 0; index < meta.analysisSegments; index++) {
		const object = await c.env.AUDIO_BUCKET.get(featureKey(meta.id, index));
		if (!object) return c.json({ error: `Analysis segment ${index} is missing.` }, 409);
		const bytes = new Uint8Array(await object.arrayBuffer());
		packed.set(bytes, position);
		position += bytes.byteLength;
	}
	const report = JSON.parse(finish_analysis(meta.channels, meta.frames, packed)) as Record<string, unknown>;
	await c.env.AUDIO_BUCKET.put(`${jobPrefix(meta.id)}report.json`, JSON.stringify({ ...report, waveform: makeWaveform(packed) }), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
	await deleteFeatureSegments(c.env.AUDIO_BUCKET, meta.id, meta.analysisSegments);
	meta.status = "ready";
	meta.progress = 100;
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ status: meta.status });
});

app.get("/api/jobs/:id", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	return meta ? c.json(meta) : c.json({ error: "Job not found." }, 404);
});

app.get("/api/jobs/:id/report", async (c) => {
	const id = c.req.param("id");
	const meta = await getMeta(c.env.AUDIO_BUCKET, id);
	if (!meta) return c.json({ error: "Job not found." }, 404);
	if (meta.status !== "ready" && meta.status !== "rendering" && meta.status !== "writing" && meta.status !== "complete") {
		return c.json({ error: "Analysis is not ready yet." }, 409);
	}
	const report = await c.env.AUDIO_BUCKET.get(`${jobPrefix(id)}report.json`);
	return report ? new Response(report.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) : c.json({ error: "Analysis report is missing." }, 404);
});

app.post("/api/jobs/:id/render", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	if (meta.status !== "ready") return c.json({ error: "Analysis is not ready for rendering." }, 409);
	const body: unknown = await c.req.json().catch(() => null);
	if (!isRecord(body) || !isPositiveOrZeroInt(body.startFrame) || !isPositiveInt(body.endFrame)
		|| body.startFrame >= body.endFrame || body.endFrame > meta.frames
		|| typeof body.targetDb !== "number" || body.targetDb < -6 || body.targetDb > 0 || typeof body.normalize !== "boolean") {
		return c.json({ error: "Invalid trim range or peak target." }, 400);
	}
	meta.status = "rendering";
	meta.progress = 0;
	meta.renderStart = body.startFrame;
	meta.renderEnd = body.endFrame;
	meta.renderSegments = Math.ceil((body.endFrame - body.startFrame) / PROCESS_FRAMES);
	meta.targetDb = body.targetDb;
	meta.normalize = body.normalize;
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ jobId: meta.id, status: meta.status, segments: meta.renderSegments }, 202);
});

app.post("/api/jobs/:id/render/measure/:segment", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	const index = Number(c.req.param("segment"));
	if (meta.status !== "rendering" || !meta.normalize || meta.renderStart === undefined || meta.renderEnd === undefined || !Number.isInteger(index) || index < 0 || index >= meta.renderSegments!) return c.json({ error: "Invalid peak measurement segment." }, 409);
	const start = meta.renderStart + index * PROCESS_FRAMES;
	const end = Math.min(meta.renderEnd, start + PROCESS_FRAMES);
	const peak = measure_chunk_peak(toSamples(await readPcmFrames(c.env.AUDIO_BUCKET, meta, start, end)));
	await c.env.AUDIO_BUCKET.put(peakKey(meta.id, index), String(peak));
	meta.progress = Math.round((index + 1) / meta.renderSegments! * 45);
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ segment: index, peak });
});

app.post("/api/jobs/:id/render/prepare", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	if (meta.status !== "rendering" || meta.renderStart === undefined || meta.renderEnd === undefined || !meta.renderSegments) return c.json({ error: "Render is not ready to prepare." }, 409);
	let maxPeak = 0;
	if (meta.normalize) for (let index = 0; index < meta.renderSegments; index++) {
		const object = await c.env.AUDIO_BUCKET.get(peakKey(meta.id, index));
		if (!object) return c.json({ error: `Peak measurement ${index} is missing.` }, 409);
		maxPeak = Math.max(maxPeak, Number(await object.text()) || 0);
	}
	const target = 10 ** (meta.targetDb! / 20);
	meta.gain = meta.normalize && maxPeak > 0 ? Math.min(target / maxPeak, 10 ** (MAX_GAIN_DB / 20)) : 1;
	meta.status = "writing";
	meta.progress = 50;
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ gain: meta.gain, segments: meta.renderSegments });
});

app.post("/api/jobs/:id/render/segment/:segment", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	const index = Number(c.req.param("segment"));
	if (meta.status !== "writing" || meta.renderStart === undefined || meta.renderEnd === undefined || !Number.isInteger(index) || index < 0 || index >= meta.renderSegments!) return c.json({ error: "Invalid render segment." }, 409);
	const start = meta.renderStart + index * PROCESS_FRAMES;
	const end = Math.min(meta.renderEnd, start + PROCESS_FRAMES);
	const processed = apply_gain(toSamples(await readPcmFrames(c.env.AUDIO_BUCKET, meta, start, end)), meta.gain ?? 1);
	await c.env.AUDIO_BUCKET.put(outputKey(meta.id, index), new Uint8Array(processed.buffer, processed.byteOffset, processed.byteLength), { httpMetadata: { contentType: "application/octet-stream" } });
	meta.progress = 50 + Math.round((index + 1) / meta.renderSegments! * 50);
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ segment: index, bytes: processed.byteLength });
});

app.post("/api/jobs/:id/render/finish", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta) return c.json({ error: "Job not found." }, 404);
	if (meta.status !== "writing" || meta.renderStart === undefined || meta.renderEnd === undefined || !meta.renderSegments) return c.json({ error: "Render is not ready to finish." }, 409);
	for (let index = 0; index < meta.renderSegments; index++) if (!await c.env.AUDIO_BUCKET.head(outputKey(meta.id, index))) return c.json({ error: `Rendered segment ${index} is missing.` }, 409);
	meta.outputFrames = meta.renderEnd - meta.renderStart;
	meta.outputParts = meta.renderSegments;
	meta.status = "complete";
	meta.progress = 100;
	await putMeta(c.env.AUDIO_BUCKET, meta);
	return c.json({ status: meta.status });
});

app.get("/api/jobs/:id/download", async (c) => {
	const meta = await getMeta(c.env.AUDIO_BUCKET, c.req.param("id"));
	if (!meta || meta.status !== "complete" || !meta.outputFrames || !meta.outputParts) return c.json({ error: "Output is not ready." }, 404);
	const partBytes = meta.outputFrames * meta.channels * 4;
	const stream = outputStream(c.env.AUDIO_BUCKET, meta);
	const downloadName = `${meta.fileName.replace(/\.wav$/i, "")}_clip.wav`;
	return new Response(stream, {
		headers: {
			"Content-Type": "audio/wav",
			"Content-Length": String(44 + partBytes),
			"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
			"Cache-Control": "private, no-store",
		},
	});
});

app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));
app.onError((error, c) => {
	console.error("Worker request failed", { message: error.message, path: c.req.path });
	return c.json({ error: "Request failed. Please retry." }, 500);
});

export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await cleanupExpiredJobs(env.AUDIO_BUCKET, Date.now() - 24 * 60 * 60 * 1000);
	},
} satisfies ExportedHandler<Env>;

async function cleanupExpiredJobs(bucket: R2Bucket, cutoff: number): Promise<void> {
	const cursorObject = await bucket.get("system/cleanup-cursor.json");
	let cursor = cursorObject ? String((await cursorObject.json<Record<string, unknown> >()).cursor ?? "") : "";
	for (let pageCount = 0; pageCount < 8; pageCount++) {
		const page = await bucket.list({ prefix: JOB_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
		const expired = page.objects.filter((object) => object.uploaded.getTime() < cutoff).map((object) => object.key);
		if (expired.length) await bucket.delete(expired);
		if (!page.truncated || !page.cursor) { await bucket.delete("system/cleanup-cursor.json"); return; }
		cursor = page.cursor;
		await bucket.put("system/cleanup-cursor.json", JSON.stringify({ cursor }));
	}
}

function outputStream(bucket: R2Bucket, meta: JobMeta): ReadableStream<Uint8Array> {
	const header = makeFloatWavHeader(meta.outputFrames!, meta.channels);
	let headerSent = false;
	let part = 0;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!headerSent) { controller.enqueue(header); headerSent = true; return; }
			while (reader || part < meta.outputParts!) {
				if (!reader) {
					const object = await bucket.get(outputKey(meta.id, part++));
					if (!object) throw new Error("Rendered WAV segment is missing.");
					reader = object.body.getReader();
				}
				const item = await reader.read();
				if (item.done) { reader = undefined; continue; }
				controller.enqueue(item.value);
				return;
			}
			controller.close();
		},
		async cancel() { await reader?.cancel(); },
	});
}

function makeFloatWavHeader(frames: number, channels: 1 | 2): Uint8Array {
	const header = new Uint8Array(44);
	const view = new DataView(header.buffer);
	const tag = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
	const dataBytes = frames * channels * 4;
	tag(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); tag(8, "WAVE"); tag(12, "fmt ");
	view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
	view.setUint32(24, RATE, true); view.setUint32(28, RATE * channels * 4, true); view.setUint16(32, channels * 4, true);
	view.setUint16(34, 32, true); tag(36, "data"); view.setUint32(40, dataBytes, true);
	return header;
}

function makeWaveform(packed: Uint8Array): number[] {
	const count = packed.byteLength / FEATURE_BYTES;
	const bins = new Array<number>(FEATURE_BINS).fill(0);
	const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
	for (let i = 0; i < count; i++) {
		const bin = Math.min(FEATURE_BINS - 1, Math.floor(i * FEATURE_BINS / count));
		bins[bin] = Math.max(bins[bin], Math.abs(view.getFloat32(i * FEATURE_BYTES + 12, true)));
	}
	return bins;
}

async function readPcmFrames(bucket: R2Bucket, meta: JobMeta, startFrame: number, endFrame: number): Promise<Uint8Array> {
	return readFileRange(bucket, meta, meta.dataOffset + startFrame * meta.channels * 4, meta.dataOffset + endFrame * meta.channels * 4);
}

async function readFileRange(bucket: R2Bucket, meta: JobMeta, start: number, end: number): Promise<Uint8Array> {
	if (start < 0 || end < start || end > meta.fileBytes) throw new Error("Requested audio range is invalid.");
	const result = new Uint8Array(end - start);
	let position = start;
	let written = 0;
	while (position < end) {
		const part = Math.floor(position / UPLOAD_PART_BYTES);
		const localOffset = position - part * UPLOAD_PART_BYTES;
		const length = Math.min(end - position, UPLOAD_PART_BYTES - localOffset);
		const object = await bucket.get(inputKey(meta.id, part), { range: { offset: localOffset, length } });
		if (!object) throw new Error(`Uploaded WAV part ${part} is missing.`);
		const bytes = new Uint8Array(await object.arrayBuffer());
		if (bytes.byteLength !== length) throw new Error(`Uploaded WAV part ${part} is incomplete.`);
		result.set(bytes, written);
		position += length;
		written += length;
	}
	return result;
}

function toSamples(bytes: Uint8Array): Float32Array {
	if (bytes.byteLength % 4 !== 0) throw new Error("Audio data is not aligned to float32 samples.");
	const samples = new Float32Array(bytes.byteLength / 4);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true);
	return samples;
}

function parseWaveHeader(bytes: Uint8Array, totalBytes: number): { channels: number; frames: number; dataOffset: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (bytes.byteLength < 12 || text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error("Only RIFF/WAVE files are supported.");
	let format = 0, channels = 0, rate = 0, bits = 0, block = 0, dataOffset = -1, dataLength = -1;
	for (let offset = 12; offset + 8 <= bytes.byteLength;) {
		const id = text(offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "data") { dataOffset = body; dataLength = size; break; }
		if (body + size > bytes.byteLength) throw new Error("WAV header or metadata exceeds the supported header area.");
		if (id === "fmt ") {
			if (size < 16) throw new Error("WAV format chunk is malformed.");
			format = view.getUint16(body, true);
			channels = view.getUint16(body + 2, true);
			rate = view.getUint32(body + 4, true);
			block = view.getUint16(body + 12, true);
			bits = view.getUint16(body + 14, true);
			if (format === 0xfffe && size >= 40) format = view.getUint32(body + 24, true);
		}
		offset = body + size + (size & 1);
	}
	if (format !== 3 || rate !== RATE || bits !== 32 || ![1, 2].includes(channels) || block !== channels * 4) throw new Error("Expected mono/stereo 48 kHz 32-bit float WAV.");
	if (dataOffset < 0 || dataLength !== totalBytes - dataOffset || dataLength % block !== 0) throw new Error("WAV data length is inconsistent.");
	return { channels, frames: dataLength / block, dataOffset };
}

async function getMeta(bucket: R2Bucket, id: string): Promise<JobMeta | undefined> {
	if (!isUuid(id)) return undefined;
	const object = await bucket.get(metaKey(id));
	if (!object) return undefined;
	const value: unknown = await object.json();
	return isRecord(value) && value.id === id ? value as unknown as JobMeta : undefined;
}

function putMeta(bucket: R2Bucket, meta: JobMeta): Promise<R2Object> {
	return bucket.put(metaKey(meta.id), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
}

async function deleteFeatureSegments(bucket: R2Bucket, id: string, count: number): Promise<void> {
	for (let first = 0; first < count; first += 1000) {
		const last = Math.min(count, first + 1000);
		await bucket.delete(Array.from({ length: last - first }, (_, offset) => featureKey(id, first + offset)));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isPositiveInt(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function isPositiveOrZeroInt(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function cleanFileName(name: string): string { return (name.split(/[\\/]/).pop() || "recording.wav").replace(/[\r\n\0]/g, "").slice(0, 160); }
function jobPrefix(id: string): string { return `${JOB_PREFIX}${id}/`; }
function metaKey(id: string): string { return `${jobPrefix(id)}meta.json`; }
function inputPrefix(id: string): string { return `${jobPrefix(id)}input/`; }
function inputKey(id: string, part: number): string { return `${inputPrefix(id)}${String(part).padStart(6, "0")}.wavpart`; }
function featureKey(id: string, index: number): string { return `${jobPrefix(id)}feature/${String(index).padStart(6, "0")}.bin`; }
function peakKey(id: string, index: number): string { return `${jobPrefix(id)}peak/${String(index).padStart(6, "0")}.txt`; }
function outputKey(id: string, index: number): string { return `${jobPrefix(id)}output/${String(index).padStart(6, "0")}.pcm`; }
