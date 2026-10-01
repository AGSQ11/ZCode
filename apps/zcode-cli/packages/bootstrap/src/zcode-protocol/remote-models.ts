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
    throw new ProtocolRequestError(
      -32602,
      `Provider 不存在、未启用或为账号套餐型 Provider（不支持动态拉取模型）: ${params.providerId}`,
    );
  }
  if (!connection.apiKey) {
    throw new ProtocolRequestError(
      -32602,
      `Provider 未配置 API Key，无法拉取模型列表: ${params.providerId}`,
    );
  }
  const base = connection.baseUrl.replace(/\/+$/u, "");
  // 路径兼容：不同 Provider 的 baseUrl 风格不一（有的自带 /v1 有的不带）。
  // 按优先级尝试候选 URL，第一个 200 即采用；全 404 才报错。
  const candidates = [
    `${base}/models`,
    base.endsWith("/v1") ? `${base.slice(0, -3)}/models` : `${base}/v1/models`,
    `${base}/api/models`,
  ];
  let response: Response | undefined;
  let lastStatus = 0;
  for (const url of candidates) {
    try {
      const authHeaders: Record<string, string> = {};
      if (connection.apiKey) {
        authHeaders.authorization = `Bearer ${connection.apiKey}`;
        // Anthropic 风格端点使用 x-api-key 请求头
        authHeaders["x-api-key"] = connection.apiKey;
        authHeaders["anthropic-version"] = "2023-06-01";
      }
      const res = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...authHeaders,
          ...(connection.headers ?? {}),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        response = res;
        break;
      }
      lastStatus = res.status;
      // 401/403 属于认证问题，换路径无意义；直接中断
      if (res.status === 401 || res.status === 403) {
        response = res;
        break;
      }
    } catch {
      // 网络/超时继续尝试下一个候选
    }
  }
  if (!response || !response.ok) {
    throw new ProtocolRequestError(
      -32603,
      `Provider 返回 ${response ? response.status : lastStatus || "无法连接"}（已尝试: ${candidates.join(", ")}）`,
    );
  }
  const body = (await response.json().catch(() => undefined)) as unknown;
  return { models: extractRemoteModelIds(body).map((id) => ({ id })) };
}
