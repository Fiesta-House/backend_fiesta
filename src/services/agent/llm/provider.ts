import OpenAI from 'openai';
import prisma from '../../../config/prisma';
import { classifyProviderRateLimit } from '../resilience.service';

const PROVIDER_TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS) || 20_000;

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 0,
  timeout: PROVIDER_TIMEOUT_MS,
});

const groq2 = process.env.GROQ_2
  ? new OpenAI({
      apiKey: process.env.GROQ_2,
      baseURL: 'https://api.groq.com/openai/v1',
      maxRetries: 0,
      timeout: PROVIDER_TIMEOUT_MS,
    })
  : null;

export const CHAT_MODEL =
  process.env.GROQ_CHAT_MODEL ||
  process.env.OPENAI_CHAT_MODEL ||
  'llama-3.1-8b-instant';

const GROQ_2_CHAT_MODEL =
  process.env.GROQ_2_CHAT_MODEL || CHAT_MODEL;

const GEMINI_CHAT_MODEL =
  process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';

const gemini = process.env.GEMINI_API_KEY
  ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      maxRetries: 0,
      timeout: PROVIDER_TIMEOUT_MS,
    })
  : null;

const geminiBackup2 = process.env.GEMINI_BACKUP2
  ? new OpenAI({
      apiKey: process.env.GEMINI_BACKUP2,
      baseURL:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      maxRetries: 0,
      timeout: PROVIDER_TIMEOUT_MS,
    })
  : null;

/**
 * OpenRouter aggregates many upstream providers behind a single
 * OpenAI-compatible endpoint.  Free models are identified by the
 * ":free" suffix (e.g. "meta-llama/llama-3.1-8b-instruct:free").
 * This client is used as the last-resort fallback when all four
 * primary/backup providers are exhausted or on cooldown.
 */
const openrouter = process.env.OPENROUTER_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      timeout: PROVIDER_TIMEOUT_MS,
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://fiesta-ai.app',
        'X-Title': process.env.OPENROUTER_TITLE || 'Fiesta AI',
      },
    })
  : null;

const configuredOpenRouterChatModel =
  String(process.env.OPENROUTER_CHAT_MODEL || '').trim();

const OPENROUTER_CHAT_MODEL =
  configuredOpenRouterChatModel &&
  configuredOpenRouterChatModel !== 'meta-llama/llama-3.1-8b-instruct:free'
    ? configuredOpenRouterChatModel
    : '';

export type ChatProvider =
  | 'groq'
  | 'groq2'
  | 'gemini'
  | 'gemini2'
  | 'openrouter';

  type GroqRateLimitSnapshot = {
  provider: 'groq' | 'groq2';
  model: string;
  observedAt: string;
  requestsPerDay: {
    limit: number | null;
    remaining: number | null;
    reset: string | null;
  };
  tokensPerMinute: {
    limit: number | null;
    remaining: number | null;
    reset: string | null;
  };
};

const groqRateLimitSnapshots = new Map<
  'groq' | 'groq2',
  GroqRateLimitSnapshot
>();

function getResponseHeader(
  headers: any,
  name: string,
): string | null {
  const value =
    headers?.get?.(name) ??
    headers?.[name.toLowerCase()] ??
    headers?.[name];

  return value == null ? null : String(value);
}

function getNumericHeader(
  headers: any,
  name: string,
): number | null {
  const value = getResponseHeader(headers, name);

  if (value === null || value.trim() === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function recordGroqRateLimits(
  provider: ChatProvider,
  model: string,
  headers: any,
): void {
  if (provider !== 'groq' && provider !== 'groq2') {
    return;
  }

  const snapshot: GroqRateLimitSnapshot = {
    provider,
    model,
    observedAt: new Date().toISOString(),

    requestsPerDay: {
      limit: getNumericHeader(
        headers,
        'x-ratelimit-limit-requests',
      ),
      remaining: getNumericHeader(
        headers,
        'x-ratelimit-remaining-requests',
      ),
      reset: getResponseHeader(
        headers,
        'x-ratelimit-reset-requests',
      ),
    },

    tokensPerMinute: {
      limit: getNumericHeader(
        headers,
        'x-ratelimit-limit-tokens',
      ),
      remaining: getNumericHeader(
        headers,
        'x-ratelimit-remaining-tokens',
      ),
      reset: getResponseHeader(
        headers,
        'x-ratelimit-reset-tokens',
      ),
    },
  };

  const hasQuotaData = [
    snapshot.requestsPerDay.limit,
    snapshot.requestsPerDay.remaining,
    snapshot.tokensPerMinute.limit,
    snapshot.tokensPerMinute.remaining,
  ].some((value) => value !== null);

  // Do not overwrite a valid snapshot with an empty response.
  if (!hasQuotaData) {
    return;
  }

  groqRateLimitSnapshots.set(provider, snapshot);
}

export function getGroqRateLimitSnapshots():
  GroqRateLimitSnapshot[] {
  return Array.from(groqRateLimitSnapshots.values());
}

const providerCooldownUntil =
  new WeakMap<Pick<OpenAI, 'chat'>, number>();

/**
 * Converts internal/database message objects into the clean
 * OpenAI-compatible message format expected by Groq/Gemini.
 *
 * Database messages may contain application-specific fields such as:
 * - createdAt
 * - updatedAt
 * - id
 * - customerId
 * - metadata
 *
 * Those fields must not be forwarded to the LLM provider.
 */

function sanitizeMessages(messages: any[]): any[] {
  return messages.map((message) => {
    const sanitized: Record<string, any> = {
      role: message.role,
      content: message.content ?? null,
    };

    // Preserve assistant tool calls.
    if (message.tool_calls !== undefined) {
      sanitized.tool_calls = message.tool_calls;
    }

    // Preserve the ID linking a tool result to its call.
    if (message.tool_call_id !== undefined) {
      sanitized.tool_call_id = message.tool_call_id;
    }

    // Preserve the tool name on tool-result messages.
    if (message.name !== undefined) {
      sanitized.name = message.name;
    }

    // Preserve legacy assistant function calls if present.
    if (message.function_call !== undefined) {
      sanitized.function_call = message.function_call;
    }

    return sanitized;
  });
}


/** 
 * AI_PRIMARY_PROVIDER=gemini puts Gemini first and keeps Groq
 * as the fallback; the default is Groq first.
 */
export function primaryProvider(
  env: NodeJS.ProcessEnv = process.env
): ChatProvider {
  // Tests pin the order explicitly so a local .env cannot
  // change their expectations.
  if (env.NODE_TEST_CONTEXT) return 'groq';

  return String(env.AI_PRIMARY_PROVIDER || '')
    .trim()
    .toLowerCase() === 'gemini'
    ? 'gemini'
    : 'groq';
}

function providerOrderFor(
  primary: ChatProvider
): ChatProvider[] {
  return primary === 'gemini'
    ? ['gemini', 'gemini2', 'groq', 'groq2', 'openrouter']
    : ['groq', 'groq2', 'gemini', 'gemini2', 'openrouter'];
}

export function getGroqCooldownUntil(
  client: Pick<OpenAI, 'chat'> = openai
): string | null {
  const until = providerCooldownUntil.get(client) || 0;

  return until > Date.now()
    ? new Date(until).toISOString()
    : null;
}

function noteProviderCooldown(
  error: any,
  client: Pick<OpenAI, 'chat'>
): void {
  const headers =
    error?.headers ?? error?.response?.headers;

  const retryAfter =
    headers?.get?.('retry-after') ??
    headers?.['retry-after'];

  const seconds = Number(retryAfter);

  const fromHeader =
    Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : retryAfter
        ? Date.parse(String(retryAfter)) - Date.now()
        : NaN;

  const status =
    error?.status ?? error?.response?.status;

  const fallback =
    status === 401 || status === 403 || status === 404
      ? 5 * 60_000
      : classifyProviderRateLimit(error) ===
          'daily_tpd_exhausted'
        ? 60 * 60_000
        : 60_000;

  const duration =
    Number.isFinite(fromHeader) && fromHeader > 0
      ? fromHeader
      : fallback;

  providerCooldownUntil.set(
    client,
    Math.max(
      providerCooldownUntil.get(client) || 0,
      Date.now() +
        Math.min(
          duration,
          24 * 60 * 60_000
        )
    )
  );
}

async function recordModelUsage(
  provider: ChatProvider,
  model: string,
  response?: any,
  error?: any,
  failover = false
): Promise<void> {
  try {
    await prisma.aiModelUsage.create({
      data: {
        provider,
        model,
        inputTokens:
          response?.usage?.prompt_tokens || 0,
        outputTokens:
          response?.usage?.completion_tokens || 0,
        totalTokens:
          response?.usage?.total_tokens || 0,
        status: error ? 'failed' : 'success',
        failover,
        errorCode: error
          ? String(
              error?.status ||
                error?.code ||
                'unknown'
            )
          : null,
      },
    });
  } catch (storageError) {
    console.error(
      'Failed to record model usage:',
      storageError
    );
  }
}

function isFailoverError(error: any): boolean {
  const status = error?.status ?? error?.response?.status;
  const names = [
    error?.name,
    error?.constructor?.name,
    error?.cause?.name,
    error?.cause?.constructor?.name,
  ].filter((value): value is string => typeof value === 'string');
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const message = String(error?.message ?? error?.cause?.message ?? '');
  const isTimeout =
    names.some(name => /timeout|connectiontimeout|connecttimeout/i.test(name)) ||
    /\btime(?:d)?\s*out\b|\btimeout\b/i.test(message);

  return (
    status === 404 ||
    status === 408 ||
    status === 413 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ECONNABORTED',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(code) ||
    isTimeout
  );
}

function isAuthenticationError(error: any): boolean {
  const status =
    error?.status ?? error?.response?.status;

  return status === 401 || status === 403;
}


// Keep Groq completion budgets below the configured TPM ceiling.
// This does not replace prompt reduction; it reduces the reserved output budget.
function withGroqCompletionBudget(
  params: Record<string, any>,
  provider: ChatProvider
): Record<string, any> {
  if (provider !== 'groq' && provider !== 'groq2') {
    return params;
  }

  const configuredLimit = Number(
    process.env.GROQ_MAX_COMPLETION_TOKENS
  );

  const maxAllowed =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.max(256, Math.min(Math.floor(configuredLimit), 1000))
      : 900;

  const request = { ...params };
  let foundBudgetField = false;

  for (const field of [
    'max_completion_tokens',
    'max_tokens',
  ] as const) {
    if (request[field] !== undefined && request[field] !== null) {
      const current = Number(request[field]);

      request[field] =
        Number.isFinite(current) && current > 0
          ? Math.min(Math.floor(current), maxAllowed)
          : maxAllowed;

      foundBudgetField = true;
    }
  }

  if (!foundBudgetField) {
    request.max_completion_tokens = maxAllowed;
  }

  return request;
}
export async function createChatCompletion(
  params: any,
  preferredProvider?: ChatProvider,
  clients: {
    groq: Pick<OpenAI, 'chat'>;
    groq2?: Pick<OpenAI, 'chat'> | null;
    gemini?: Pick<OpenAI, 'chat'> | null;
    gemini2?: Pick<OpenAI, 'chat'> | null;
    openrouter?: Pick<OpenAI, 'chat'> | null;
  } = {
    groq: openai,
    groq2,
    gemini,
    gemini2: geminiBackup2,
    openrouter,
  },
  primary: ChatProvider = primaryProvider()
): Promise<{
  response: any;
  provider: ChatProvider;
  completionCalls: number;
}> {
  const order = providerOrderFor(primary);

  const start = preferredProvider ?? primary;

  const startIndex = Math.max(
    0,
    order.indexOf(start)
  );

  // Follow-up rounds start where the previous
  // round succeeded, then wrap around to the rest.
  const providers = [
    ...order.slice(startIndex),
    ...order.slice(0, startIndex),
  ];

  const models: Record<
    ChatProvider,
    string
  > = {
    groq: params.model,
    groq2: GROQ_2_CHAT_MODEL,
    gemini: GEMINI_CHAT_MODEL,
    gemini2:
      process.env.GEMINI_BACKUP2_CHAT_MODEL ||
      GEMINI_CHAT_MODEL,
    openrouter: OPENROUTER_CHAT_MODEL,
  };

  let completionCalls = 0;
  let lastError: any;

  /*
   * Sanitize the messages ONCE before they are sent
   * to any provider.
   *
   * This prevents database/application fields such
   * as createdAt from leaking into the OpenAI-compatible
   * provider payload.
   */
  const sanitizedParams = {
    ...params,
    messages: Array.isArray(params.messages)
      ? sanitizeMessages(params.messages)
      : params.messages,
  };

  // This internal option is never sent directly to a provider.
  const requestedGroqReasoningEffort = ['low', 'medium', 'high'].includes(
    sanitizedParams.groqReasoningEffort
  )
    ? sanitizedParams.groqReasoningEffort
    : undefined;

  const providerParams = { ...sanitizedParams };
  delete providerParams.groqReasoningEffort;

  for (const provider of providers) {
    const client = clients[provider];

    if (!client) continue;

    const model = models[provider];

    if (!model) {
      console.warn('[AI_PROVIDER] Skipping provider: no usable model configured.', {
        provider,
      });
      continue;
    }

    const cooldownUntil = providerCooldownUntil.get(client) || 0;

    if (Date.now() < cooldownUntil) {
      console.warn('[AI_PROVIDER] Skipping provider in cooldown:', {
        provider,
        cooldownUntil: new Date(cooldownUntil).toISOString(),
      });
      continue;
    }

    try {
      completionCalls++;

      const requestParams = withGroqCompletionBudget(
        providerParams,
        provider
      );

      // GPT-OSS supports reasoning_effort. Do not send it to other models/providers.
      const reasoningEffortApplied =
        (provider === 'groq' || provider === 'groq2') &&
        /^openai\/gpt-oss(?:-|$)/i.test(model)
          ? requestedGroqReasoningEffort
          : undefined;

      if (reasoningEffortApplied) {
        requestParams.reasoning_effort = reasoningEffortApplied;
      }

      console.info('[AI_PROVIDER] Request starting:', {
        provider,
        model,
        messageCount: Array.isArray(requestParams.messages)
          ? requestParams.messages.length
          : 0,
        toolCount: Array.isArray(requestParams.tools)
          ? requestParams.tools.length
          : 0,
        maxTokens:
          requestParams.max_completion_tokens ??
          requestParams.max_tokens ??
          null,
        reasoningEffort: reasoningEffortApplied ?? null,
      });

      const completionRequest =
        client.chat.completions.create({
          ...requestParams,
          model,
        } as any);

      const {
        data: response,
        response: rawResponse,
      } = await completionRequest.withResponse();

      const firstChoice = response?.choices?.[0];
      const completionDetails = response?.usage?.completion_tokens_details;

      console.info('[AI_PROVIDER] Request completed:', {
        provider,
        model,
        finishReason: firstChoice?.finish_reason ?? null,
        completionTokens: response?.usage?.completion_tokens ?? null,
        reasoningTokens: completionDetails?.reasoning_tokens ?? null,
        hasTextContent:
          typeof firstChoice?.message?.content === 'string' &&
          firstChoice.message.content.trim().length > 0,
        toolCallCount: Array.isArray(firstChoice?.message?.tool_calls)
          ? firstChoice.message.tool_calls.length
          : 0,
      });

      recordGroqRateLimits(
        provider,
        model,
        rawResponse.headers,
      );

      await recordModelUsage(
        provider,
        model,
        response,
        undefined,
        provider !== primary
      );

      return {
        response,
        provider,
        completionCalls,
      };
    } catch (error: any) {
      lastError = error;

      await recordModelUsage(
        provider,
        model,
        undefined,
        error,
        provider !== primary
      );

      const shouldFailOver =
        isFailoverError(error) ||
        isAuthenticationError(error);

      if (shouldFailOver) {
        noteProviderCooldown(
          error,
          client
        );
      }

      if (!shouldFailOver) {
        throw error;
      }

      const status =
        error?.status ??
        error?.response?.status;

      console.warn(
        'Chat provider unavailable; trying the next configured fallback:',
        {
          provider,
          status: status || error?.code,
        }
      );
    }
  }

  if (lastError) {
    throw lastError;
  }

  if (
    start === 'gemini' &&
    !clients.gemini
  ) {
    throw new Error(
      'Gemini fallback is not configured'
    );
  }

  throw new Error(
    'No configured chat provider is available'
  );
}