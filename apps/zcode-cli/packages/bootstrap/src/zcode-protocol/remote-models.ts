// 「获取全部模型」：从 Provider API 的 GET {baseUrl}/models 拉取可用模型 id 列表。
// 解析在协议边界做兼容收口：OpenAI 的 { data: [{ id }] }、部分厂商的 { models: [...] }、
// 裸数组 [{ id }] 三种形状都归一成 { models: [{ id }] }。响应体有界，不落盘。
import { zcodeProviderListRemoteModelsParamsSchema } from "@zcode/shared";
import { parseParams, ProtocolRequestError, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const MAX_REMOTE_MODELS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;

/** 从任意 [OI]-兼容响应体中提取模型 id；形状不认识时返回空数组。 */
export function extractRemoteModelIds(body: unknown): string[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as { data?: unknown }).data ?? (body as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? ((entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name)
          : undefined;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
    if (ids.length >= MAX_REMOTE_MODELS) break;
  }
  return ids;
}

export async function listProviderRemoteModels(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeProviderListRemoteModelsParamsSchema, rawParams);
  const connection = context.deps.getRegistryProviderConnection?.(params.providerId);
  if (!connection) {
    throw new ProtocolRequestError(-32602, `Provider 不存在或无法连接: ${params.providerId}`);
  }
  const base = connection.baseUrl.replace(/\/+$/u, "");
  const url = `${base}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
        ...(connection.headers ?? {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProtocolRequestError(
      -32603,
      `拉取模型列表失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new ProtocolRequestError(-32603, `Provider 返回 ${response.status}`);
  }
  const body = (await response.json().catch(() => undefined)) as unknown;
  return { models: extractRemoteModelIds(body).map((id) => ({ id })) };
}
