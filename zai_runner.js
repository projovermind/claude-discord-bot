/**
 * Z.AI Runner — OpenAI-compatible API + 로컬 도구 실행 루프
 * Claude CLI 없이 z.ai / OpenAI / DeepSeek 등 사용 가능
 */
const OpenAI = require('openai');
const { executeTool, getToolsForAgent } = require('./tool_executor');

// ─────────────────────────────────────────
//  백엔드 프리셋
// ─────────────────────────────────────────
const BACKENDS = {
  zai: {
    baseURL: 'https://api.z.ai/api/paas/v4/',
    envKey: 'ZAI_API_KEY',
    models: {
      default: 'glm-5',
      haiku: 'glm-5',
      sonnet: 'glm-5',
      opus: 'glm-5',
    },
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1/',
    envKey: 'DEEPSEEK_API_KEY',
    models: {
      default: 'deepseek-chat',
      haiku: 'deepseek-chat',
      sonnet: 'deepseek-chat',
      opus: 'deepseek-reasoner',
    },
  },
  openai: {
    baseURL: 'https://api.openai.com/v1/',
    envKey: 'OPENAI_API_KEY',
    models: {
      default: 'gpt-4o',
      haiku: 'gpt-4o-mini',
      sonnet: 'gpt-4o',
      opus: 'gpt-5.1',
    },
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1/',
    envKey: 'OPENROUTER_API_KEY',
    models: {
      default: 'anthropic/claude-sonnet-4',
      haiku: 'anthropic/claude-haiku-4',
      sonnet: 'anthropic/claude-sonnet-4',
      opus: 'anthropic/claude-opus-4',
    },
  },
};

// ─────────────────────────────────────────
//  클라이언트 캐시 (백엔드별 1개)
// ─────────────────────────────────────────
const clientCache = new Map();

function getClient(backendName) {
  if (clientCache.has(backendName)) return clientCache.get(backendName);

  const backend = BACKENDS[backendName];
  if (!backend) throw new Error(`Unknown backend: ${backendName}. Available: ${Object.keys(BACKENDS).join(', ')}`);

  const apiKey = process.env[backend.envKey];
  if (!apiKey) throw new Error(`${backend.envKey} environment variable not set for backend "${backendName}"`);

  const client = new OpenAI({ baseURL: backend.baseURL, apiKey });
  clientCache.set(backendName, client);
  return client;
}

// ─────────────────────────────────────────
//  메인 실행 함수
// ─────────────────────────────────────────

/**
 * OpenAI-compatible API로 에이전트 실행 (도구 호출 루프 포함)
 *
 * @param {object} options
 * @param {string} options.message - 사용자 메시지
 * @param {string} options.systemPrompt - 시스템 프롬프트
 * @param {object} options.agent - 에이전트 설정 (allowedTools, workingDir 등)
 * @param {string} options.backend - 백엔드 이름 (zai, deepseek, openai, openrouter)
 * @param {string} [options.model] - 모델 오버라이드 (없으면 백엔드 기본값)
 * @param {string} [options.workingDir] - 작업 디렉토리
 * @param {function} [options.onToolCall] - 도구 호출 콜백 (이름, 인자) → 로깅용
 * @param {function} [options.onChunk] - 스트리밍 청크 콜백 (텍스트) → Discord 실시간 업데이트
 * @param {number} [options.maxToolRounds=30] - 최대 도구 호출 라운드
 * @returns {Promise<{text: string, toolCalls: Array, usage: object}>}
 */
async function runAgent(options) {
  const {
    message,
    systemPrompt,
    agent,
    backend: backendName = 'zai',
    model: modelOverride,
    workingDir,
    onToolCall,
    onChunk,
    maxToolRounds = 30,
  } = options;

  const backend = BACKENDS[backendName];
  if (!backend) throw new Error(`Unknown backend: ${backendName}`);

  const client = getClient(backendName);
  const tools = getToolsForAgent(agent);
  const agentWorkingDir = workingDir || agent.workingDir || process.cwd();

  // 모델 결정: modelOverride → agent.model → backend default
  const agentModel = agent.model || 'default';
  const model = modelOverride || backend.models[agentModel] || backend.models.default;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];

  let totalToolCalls = [];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let round = 0; round < maxToolRounds; round++) {
    const requestParams = {
      model,
      messages,
      temperature: 0.3,
      max_tokens: 16384,
    };

    // 도구가 있으면 추가
    if (tools.length > 0) {
      requestParams.tools = tools;
      requestParams.tool_choice = 'auto';
    }

    let response;
    try {
      response = await client.chat.completions.create(requestParams);
    } catch (err) {
      // API 에러 처리
      const errorMsg = err.message || String(err);
      if (err.status === 429) {
        // Rate limit — 잠시 대기 후 재시도
        await new Promise(r => setTimeout(r, 3000));
        try {
          response = await client.chat.completions.create(requestParams);
        } catch (retryErr) {
          throw new Error(`API rate limit exceeded after retry: ${retryErr.message}`);
        }
      } else {
        throw new Error(`API error (${backendName}/${model}): ${errorMsg}`);
      }
    }

    const choice = response.choices?.[0];
    if (!choice) throw new Error('No response from API');

    // 사용량 집계
    if (response.usage) {
      totalUsage.prompt_tokens += response.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += response.usage.completion_tokens || 0;
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // 도구 호출이 없으면 완료
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const text = assistantMessage.content || '';
      if (onChunk) onChunk(text);
      return { text, toolCalls: totalToolCalls, usage: totalUsage };
    }

    // 도구 호출 실행
    for (const toolCall of assistantMessage.tool_calls) {
      const fnName = toolCall.function.name;
      let fnArgs;

      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        fnArgs = {};
      }

      if (onToolCall) onToolCall(fnName, fnArgs);
      totalToolCalls.push({ name: fnName, args: fnArgs });

      // 로컬 도구 실행
      const result = executeTool(fnName, fnArgs, agentWorkingDir);

      // 결과 크기 제한 (128KB)
      const truncated = result.length > 131072
        ? result.substring(0, 131072) + '\n... (truncated)'
        : result;

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: truncated,
      });
    }
  }

  // 최대 라운드 도달
  return {
    text: '(도구 호출 최대 라운드 도달)',
    toolCalls: totalToolCalls,
    usage: totalUsage,
  };
}

// ─────────────────────────────────────────
//  유틸리티
// ─────────────────────────────────────────

/**
 * 백엔드가 사용 가능한지 확인 (API 키 설정 여부)
 */
function isBackendAvailable(backendName) {
  const backend = BACKENDS[backendName];
  if (!backend) return false;
  return !!process.env[backend.envKey];
}

/**
 * 사용 가능한 백엔드 목록
 */
function listAvailableBackends() {
  return Object.keys(BACKENDS).filter(isBackendAvailable);
}

/**
 * 커스텀 백엔드 추가 (런타임)
 */
function registerBackend(name, config) {
  BACKENDS[name] = config;
}

module.exports = {
  runAgent,
  isBackendAvailable,
  listAvailableBackends,
  registerBackend,
  BACKENDS,
};
