import { z } from "zod";
import { DomainError } from "./domain";
import { analyzeUsage, dayMs, minuteMs, usageRange, type MinuteSample, type NpuCard } from "./npu-usage";
import { shiftDate } from "./schedule";
import type { Resource, State } from "./types";

const count = z.number().int().min(0).max(128);
const percent = z.number().min(0).max(100);
const point = z.tuple([z.number().int().min(0).max(1439), count, count, count, z.number().min(0)]);
const card = z.object({
  key: z.string().regex(/^\d+-\d+$/),
  state: z.enum(["idle", "active", "occupied_low", "occupied_unknown", "fault", "smi_fail", "missing", "no_data"]),
  util: percent.nullable(),
  hbm: percent.nullable(),
}).strict();
const payload = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ip: z.string().min(1).max(64),
  expected: count.min(1),
  points: z.array(point).max(1440),
  snapshot: z.object({ at: z.number().int(), cards: z.array(card).max(128) }).strict().optional(),
}).strict();

export async function authorizeCollector(request: Request, secret: string | undefined) {
  if (!secret || secret.length < 32) throw new DomainError(503, "采集同步尚未配置");
  const token = request.headers.get("authorization") ?? "";
  if (!token.startsWith("Bearer ") || token.length > 512) throw new DomainError(401, "采集认证失败");
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(token.slice(7)), digest(secret)]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual[i] ^ expected[i];
  if (diff !== 0) throw new DomainError(401, "采集认证失败");
}

export async function readCollectorPayload(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new DomainError(415, "请使用 JSON 请求");
  }
  const limit = 100_000;
  if (Number(request.headers.get("content-length")) > limit) {
    throw new DomainError(413, "单机单日采集数据过大");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError(400, "采集数据为空");
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new DomainError(413, "单机单日采集数据过大");
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError(400, "采集数据不是有效的 JSON");
  }
}

export async function saveUsage(db: D1Database, input: unknown, now: number) {
  const parsed = payload.safeParse(input);
  if (!parsed.success) throw new DomainError(400, "采集数据格式不正确");
  const body = parsed.data;
  const range = usageRange(body.day, body.day, now);
  const samples: Record<string, MinuteSample> = {};
  for (const [minute, observed, occupied, computeCount, computeSum] of body.points) {
    if (samples[minute] || observed > body.expected || occupied > observed || computeCount > observed ||
        computeSum > computeCount * 100 || range.start + minute * minuteMs >= range.end) {
      throw new DomainError(400, "分钟数据超出采集范围或重复");
    }
    samples[minute] = [observed, occupied, computeCount, computeSum];
  }
  if (body.snapshot && (body.snapshot.at < range.start || body.snapshot.at >= range.start + dayMs ||
      body.snapshot.at > now || body.snapshot.cards.length > body.expected ||
      new Set(body.snapshot.cards.map(c => c.key)).size !== body.snapshot.cards.length)) {
    throw new DomainError(400, "卡状态快照不符合采集日期或卡数");
  }
  const { results } = await db.prepare("SELECT payload FROM resources").all<{ payload: string }>();
  const matches = results.map(row => JSON.parse(row.payload) as Resource)
    .filter(resource => !resource.deleted && resource.ip.trim() === body.ip.trim());
  if (matches.length !== 1 || matches[0].zone === "green") {
    throw new DomainError(409, "采集 IP 无法唯一匹配蓝区资源");
  }
  const resourceId = matches[0].id;
  const statements = [db.prepare(`
    INSERT INTO npu_days(id, resource_id, day, expected, samples) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      expected = max(npu_days.expected, excluded.expected),
      samples = json_patch(npu_days.samples, excluded.samples)
  `).bind(`${body.day}/${resourceId}`, resourceId, body.day, body.expected, JSON.stringify(samples))];
  if (body.snapshot) {
    statements.push(db.prepare(`
      INSERT INTO npu_latest(resource_id, expected, sampled_at, cards) VALUES (?, ?, ?, ?)
      ON CONFLICT(resource_id) DO UPDATE SET
        expected = excluded.expected, sampled_at = excluded.sampled_at, cards = excluded.cards
      WHERE excluded.sampled_at >= npu_latest.sampled_at
    `).bind(resourceId, body.expected, body.snapshot.at, JSON.stringify(body.snapshot.cards)));
  }
  await db.batch(statements);
  return { resourceId, day: body.day, minutes: body.points.length };
}

export async function readUsage(db: D1Database, state: State, url: URL, now: number) {
  const range = usageRange(url.searchParams.get("start") ?? "", url.searchParams.get("end") ?? "", now);
  const [days, latest] = await Promise.all([
    db.prepare("SELECT resource_id, day, expected, samples FROM npu_days WHERE id >= ? AND id < ?")
      .bind(`${range.startDay}/`, `${shiftDate(range.endDay, 1)}/`).all<{ resource_id: string; day: string; expected: number; samples: string }>(),
    db.prepare("SELECT resource_id, expected, sampled_at, cards FROM npu_latest")
      .all<{ resource_id: string; expected: number; sampled_at: number; cards: string }>(),
  ]);
  return analyzeUsage(
    state,
    days.results.map(row => ({ resourceId: row.resource_id, day: row.day, expected: row.expected, samples: JSON.parse(row.samples) })),
    latest.results.map(row => ({
      resourceId: row.resource_id, expected: row.expected,
      snapshot: { at: row.sampled_at, cards: JSON.parse(row.cards) as NpuCard[] },
    })),
    range,
    url.searchParams.get("group") ?? "",
    url.searchParams.get("machine") ?? "",
  );
}
