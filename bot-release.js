require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { runAgent: runZAI, isBackendAvailable } = require('./zai_runner');

// ─────────────────────────────────────────
//  Claude CLI 경로 탐지 (launchctl PATH 문제 방지)
// ─────────────────────────────────────────
function findClaudeBin() {
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // fallback: which 명령으로 찾기
  try {
    return execSync('which claude 2>/dev/null').toString().trim() || 'claude';
  } catch {
    return 'claude';  // 최후의 수단
  }
}
const CLAUDE_BIN = findClaudeBin();
console.log(`🔧 Claude CLI: ${CLAUDE_BIN}`);

// ─────────────────────────────────────────
//  단일 인스턴스 보장 (PID Lock)
// ─────────────────────────────────────────
const LOCK_FILE = '/tmp/claude-discord-bot.pid';

function acquireLock() {
  try {
    // 기존 lock 파일 확인
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (existingPid && !isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0); // 프로세스 존재 여부 확인 (시그널 미전송)
          // 프로세스가 살아있음 → 이전 인스턴스 강제 종료
          console.log(`⚠️ 이전 인스턴스 발견 (PID: ${existingPid}), 종료 시도...`);
          process.kill(existingPid, 'SIGTERM');
          // 잠시 대기 후 확인
          try {
            const start = Date.now();
            while (Date.now() - start < 3000) {
              try { process.kill(existingPid, 0); } catch { break; }
            }
            // 아직 살아있으면 강제 종료
            try { process.kill(existingPid, 'SIGKILL'); } catch {}
          } catch {}
          console.log(`✅ 이전 인스턴스 (PID: ${existingPid}) 종료 완료`);
        } catch {
          // 프로세스가 이미 죽어있음 → stale lock
          console.log(`🧹 Stale lock 파일 정리 (PID: ${existingPid} 이미 종료됨)`);
        }
      }
    }
    // 새 PID 기록
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    console.log(`🔒 PID lock 획득: ${process.pid}`);
  } catch (err) {
    console.error(`❌ Lock 파일 처리 실패: ${err.message}`);
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
      if (pid === process.pid.toString()) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {}
}

// Lock 획득
acquireLock();

// 종료 시 Lock 해제 + 세션 즉시 저장
function gracefulShutdown() {
  try {
    // 세션 즉시 저장 (쓰로틀 무시)
    const SESSION_FILE_PATH = path.join(__dirname, '.sessions.json');
    const obj = {};
    for (const [k, v] of channelSessions) obj[k] = v;
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(obj, null, 2), 'utf-8');
    console.log(`💾 세션 ${channelSessions.size}개 저장 완료`);
  } catch {}
  releaseLock();
  process.exit(0);
}
process.on('exit', releaseLock);
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ─────────────────────────────────────────
//  설정 파일 로드/저장
// ─────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const TMP_DIR = '/tmp/claude-discord';

let _configCache = null;
let _configMtime = 0;

function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (_configCache && stat.mtimeMs === _configMtime) return _configCache;
    _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    _configMtime = stat.mtimeMs;
    return _configCache;
  } catch { return { agents: {}, channelBindings: {} }; }
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  _configCache = null;
  _configMtime = 0;
}

// tmp 디렉토리 생성
fs.mkdirSync(TMP_DIR, { recursive: true });

// ─────────────────────────────────────────
//  Secrets — ZhiPu API 키 로드 + 로테이션
// ─────────────────────────────────────────
const SECRETS_PATH = path.join(__dirname, 'config', 'secrets.json');
let _zhipuKeyIndex = 0;

function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8')); } catch { return {}; }
}

/** ZhiPu API 키 반환 (2키 로테이션). .env 우선, 없으면 secrets.json */
function getZhipuApiKey() {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY;
  const secrets = loadSecrets();
  const keys = [secrets.zhipu_api_key, secrets.zhipu_api_key_2].filter(Boolean);
  if (keys.length === 0) return null;
  const key = keys[_zhipuKeyIndex % keys.length];
  return key;
}

function rotateZhipuKey() {
  _zhipuKeyIndex++;
  console.log(`🔑 ZhiPu API 키 로테이션 → slot ${_zhipuKeyIndex % 2}`);
}

function getZhipuBaseUrl() {
  const secrets = loadSecrets();
  return secrets.zhipu_base_url || 'https://api.z.ai/api/paas/v4/';
}

// ZAI_API_KEY가 .env에 없으면 secrets.json에서 주입
if (!process.env.ZAI_API_KEY) {
  const key = getZhipuApiKey();
  if (key) {
    process.env.ZAI_API_KEY = key;
    console.log('🔑 ZhiPu API 키 로드 (config/secrets.json)');
  }
}

// ─────────────────────────────────────────
//  Agent Rules — 채널별 모델 라우팅 (범용)
// ─────────────────────────────────────────
const AGENT_RULES_PATH = path.join(__dirname, 'agent-rules.json');
let _agentRules = null;       // 원본 JSON
let _agentRulesMtime = 0;
let _channelModelMap = null;  // channelId → model 캐시

function loadAgentRules() {
  try {
    const stat = fs.statSync(AGENT_RULES_PATH);
    if (stat.mtimeMs !== _agentRulesMtime || !_agentRules) {
      _agentRules = JSON.parse(fs.readFileSync(AGENT_RULES_PATH, 'utf-8'));
      _agentRulesMtime = stat.mtimeMs;
      // agents 객체에서 channel_id → model 매핑 테이블 빌드
      _channelModelMap = {};
      for (const [name, def] of Object.entries(_agentRules.agents || {})) {
        if (def.channel_id && def.model) {
          _channelModelMap[def.channel_id] = def.model;
        }
      }
      console.log(`📐 Agent rules 로드 (${Object.keys(_channelModelMap).length}개 채널 모델 매핑)`);
    }
  } catch (err) {
    if (!_agentRules) {
      // 파일 없음 → 빈 규칙 (기존 동작 유지)
      _agentRules = { model_tiers: {}, agents: {} };
      _channelModelMap = {};
    }
  }
  return _agentRules;
}

/**
 * 채널 ID → 모델 문자열 조회.
 * agent-rules.json의 agents[*].channel_id로 매핑.
 * 매핑 없으면 null (기본 모델 유지).
 */
function getChannelModel(channelId) {
  loadAgentRules();
  return _channelModelMap?.[channelId] || null;
}

/**
 * 모델 문자열 → model_tiers에서 티어 정보 해석.
 * { cliModel, backend?, zaiModel? } 또는 null.
 */
function resolveModelTier(modelStr) {
  if (!modelStr) return null;
  const rules = loadAgentRules();
  for (const [, tierDef] of Object.entries(rules.model_tiers || {})) {
    if (tierDef.id === modelStr) {
      return {
        cliModel: tierDef.cli_model || modelStr,
        backend: tierDef.backend || null,
        zaiModel: tierDef.zai_model || null,
      };
    }
  }
  // model_tiers에 정의 안 된 모델 → CLI 모델명으로 직접 사용
  return { cliModel: modelStr, backend: null, zaiModel: null };
}

/**
 * 모델 문자열 → 사용자 친화적 라벨 변환.
 * 예: 'claude-opus-4-6' → 'Claude Opus 4.6', 'glm-5' → 'GLM-5'
 */
function getModelDisplayLabel(modelStr) {
  if (!modelStr) return null;
  let m = modelStr.toLowerCase();

  // 짧은 티어명 → full ID 조회 (agent-rules.json 우선, 없으면 기본값)
  const DEFAULT_TIERS = { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5' };
  const rules = loadAgentRules();
  const tierDef = (rules.model_tiers || {})[m];
  if (tierDef?.id) m = tierDef.id.toLowerCase();
  else if (DEFAULT_TIERS[m]) m = DEFAULT_TIERS[m];

  // 버전 추출: 'claude-opus-4-6' → '4.6', 'claude-haiku-4-5-20251001' → '4.5'
  const verMatch = m.match(/(\d+)-(\d+)(?:-\d{8,})?$/);
  const ver = verMatch ? `${verMatch[1]}.${verMatch[2]}` : null;

  if (m.includes('opus')) return `Claude Opus${ver ? ' ' + ver : ''}`;
  if (m.includes('sonnet')) return `Claude Sonnet${ver ? ' ' + ver : ''}`;
  if (m.includes('haiku')) return `Claude Haiku${ver ? ' ' + ver : ''}`;
  if (m.includes('glm')) return 'GLM-5';
  return modelStr;
}

/**
 * exclusive_files 수정 감지.
 * model_tiers.opus.exclusive_files에 매칭되면 true.
 */
function isExclusiveFile(filePath) {
  if (!filePath) return false;
  const rules = loadAgentRules();
  const excl = rules.model_tiers?.opus?.exclusive_files;
  if (!excl || !Array.isArray(excl)) return false;
  return excl.some(pattern => filePath.endsWith(pattern) || filePath.includes(pattern));
}

/**
 * 스마트 모델 라우팅 — 프롬프트 내용 분석으로 동적 모델 결정.
 * @param {string} prompt - 사용자 메시지
 * @param {string} channelDefaultModel - 채널 기본 모델 (agent-rules.json의 model)
 * @returns {{ model: string, reason: string, label: string } | null}
 *   null이면 스마트 라우팅 비활성 → 채널 기본 모델 사용
 */
function smartRouteModel(prompt, channelDefaultModel) {
  const rules = loadAgentRules();
  const sr = rules.smart_routing;
  if (!sr?.enabled) return null;

  const text = prompt.toLowerCase();
  const opusModel = sr.escalation_model || rules.model_tiers?.opus?.id;
  const econModel = sr.economy_model || channelDefaultModel;

  // 1) exclusive_files 키워드 매칭 → 강제 Opus
  const exclFiles = rules.model_tiers?.opus?.exclusive_files || [];
  for (const filePath of exclFiles) {
    // 파일명(확장자 제외) 및 전체 경로 키워드로 매칭
    const fileName = filePath.split('/').pop().replace(/\.\w+$/, '');
    if (text.includes(fileName) || text.includes(filePath)) {
      return {
        model: opusModel,
        reason: 'exclusive_files',
        label: `Opus (exclusive: ${fileName})`,
      };
    }
  }

  // 2) 크로스-모듈 키워드 → Opus 추천
  const crossKws = sr.cross_module_keywords || [];
  const crossHit = crossKws.find(kw => text.includes(kw.toLowerCase()));
  if (crossHit) {
    return {
      model: opusModel,
      reason: 'cross_module',
      label: `Opus (크로스-모듈: "${crossHit}")`,
    };
  }

  // 3) 단일 모듈 키워드 → economy 모델
  const singleKws = sr.single_module_keywords || [];
  const singleHit = singleKws.find(kw => text.includes(kw.toLowerCase()));
  if (singleHit) {
    return {
      model: econModel,
      reason: 'single_module',
      label: `${econModel.includes('glm') ? 'GLM-5' : econModel} (단일 모듈)`,
    };
  }

  // 4) 판단 불가 → null (채널 기본 모델 유지)
  return null;
}

// 초기 로드 (파일 없으면 조용히 무시)
loadAgentRules();

// ─────────────────────────────────────────
//  Discord 클라이언트
// ─────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildWebhooks,
  ],
});

const MAX_RESPONSE_LENGTH = 1900;
const MAX_CONCURRENT_PER_CHANNEL = 1;  // 채널당 동시 작업 수 (1 = 순차 + 컨텍스트 합류)
const MAX_QUEUE_SIZE = 5;           // 채널별 최대 대기열
const MESSAGE_DEDUP_TTL = 60000;    // 중복 메시지 무시 (60초)
const SESSION_TTL = 30 * 60 * 1000; // 세션 만료 (30분)
const DISCORD_FILE_LIMIT = 10 * 1024 * 1024; // 10MB
const activeRequests = new Set();      // 하위 호환용 (대시보드 등)
const activeTaskCount = new Map();     // channelId → 현재 실행 중인 작업 수
const botStartTime = Date.now();
let totalProcessed = 0;   // 봇 시작 이후 처리 완료 건수
const taskHistory = [];   // { timestamp, durationMs } — 최근 24시간 작업 기록

// ── 메시지 큐 시스템 ──
const messageQueues = new Map();    // channelId → [{ message, prompt }]
const activeProcesses = new Map();  // taskId → { proc, abortController, agentLabel, channelId }

function getTaskCount(channelId) {
  return activeTaskCount.get(channelId) || 0;
}
function incrementTaskCount(channelId) {
  activeTaskCount.set(channelId, getTaskCount(channelId) + 1);
  activeRequests.add(channelId);  // 하위 호환
}
function decrementTaskCount(channelId) {
  const count = getTaskCount(channelId) - 1;
  if (count <= 0) {
    activeTaskCount.delete(channelId);
    activeRequests.delete(channelId);  // 하위 호환
  } else {
    activeTaskCount.set(channelId, count);
  }
}

function getQueue(channelId) {
  if (!messageQueues.has(channelId)) messageQueues.set(channelId, []);
  return messageQueues.get(channelId);
}

async function processNextInQueue(channelId) {
  const queue = getQueue(channelId);
  if (queue.length === 0) return;

  // 큐에 쌓인 메시지를 모두 합쳐서 하나의 프롬프트로 전달
  // → 이전 작업의 세션 컨텍스트를 유지하면서 추가 요청을 참고할 수 있음
  if (queue.length === 1) {
    const next = queue.shift();
    console.log(`📬 큐에서 다음 메시지 처리: ch=${channelId}`);
    await handleClaude(next.message, '!claude ' + next.prompt);
  } else {
    // 여러 메시지가 쌓여 있으면 합쳐서 하나로 전달
    const items = queue.splice(0, queue.length);
    const lastMessage = items[items.length - 1].message;  // 마지막 메시지 객체로 응답
    const mergedPrompt = items.map((q, i) => `[추가 요청 ${i + 1}] ${q.prompt}`).join('\n\n');
    const contextPrefix = `⚠️ 이전 작업 도중 아래 ${items.length}개의 추가 요청이 들어왔습니다. 이전 작업 결과를 참고하여 순서대로 처리해주세요:\n\n`;
    console.log(`📬 큐에서 ${items.length}개 메시지 병합 처리: ch=${channelId}`);
    await handleClaude(lastMessage, '!claude ' + contextPrefix + mergedPrompt);
  }
}

// ── 메시지 중복 처리 방지 (게이트웨이 재전달 대응) ──────
const processedMessages = new Set();
// MESSAGE_DEDUP_TTL은 상단 상수 영역에서 정의됨

function markMessageProcessed(messageId) {
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), MESSAGE_DEDUP_TTL);
}

// ── 대화 세션 관리 (채널별 컨텍스트 유지, 디스크 영구 저장) ──────
const SESSION_FILE = path.join(__dirname, '.sessions.json');
const channelSessions = new Map(); // channelId -> { sessionId, lastUsed, turnCount, summary }
// SESSION_TTL은 상단 상수 영역에서 정의됨
const SESSION_MAX_TURNS = 30; // 30턴 후 자동 요약 + 리셋 (컨텍스트 비대화 방지)

// 시작 시 디스크에서 세션 복원
function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      for (const [channelId, session] of Object.entries(data)) {
        channelSessions.set(channelId, session);
      }
      console.log(`📂 세션 ${channelSessions.size}개 복원됨`);
    }
  } catch (err) {
    console.warn('⚠️ 세션 파일 로드 실패:', err.message);
  }
}

// 디스크에 세션 저장 (쓰로틀: 5초에 1번)
let _sessionSavePending = false;
function saveSessions() {
  if (_sessionSavePending) return;
  _sessionSavePending = true;
  setTimeout(() => {
    try {
      const obj = {};
      for (const [k, v] of channelSessions) obj[k] = v;
      const tmpPath = SESSION_FILE + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
      fs.renameSync(tmpPath, SESSION_FILE);
    } catch (err) {
      console.warn('⚠️ 세션 저장 실패:', err.message);
    }
    _sessionSavePending = false;
  }, 5000);
}

// 시작 시 로드
loadSessions();

function getSessionId(channelId) {
  const session = channelSessions.get(channelId);
  if (!session) return null;
  // SESSION_TTL이 0이면 만료 없이 영구 유지
  if (SESSION_TTL > 0 && Date.now() - session.lastUsed > SESSION_TTL) {
    channelSessions.delete(channelId);
    saveSessions();
    console.log(`🧹 세션 만료 정리: channelId=${channelId}`);
    return null;
  }
  session.lastUsed = Date.now();
  return session.sessionId;
}

function setSessionId(channelId, sessionId) {
  const existing = channelSessions.get(channelId) || {};
  channelSessions.set(channelId, {
    sessionId,
    lastUsed: Date.now(),
    turnCount: (existing.turnCount || 0) + 1,
    summary: existing.summary || null,
  });
  saveSessions();
}

// 세션 턴 수 초과 시 요약 후 리셋
async function maybeRotateSession(channelId, agent) {
  const session = channelSessions.get(channelId);
  if (!session || !session.sessionId) return null;

  // per-agent maxTurns 지원 (config에 maxTurns 있으면 우선, 없으면 글로벌 기본값)
  const config = loadConfig();
  const agentId = config.channelBindings?.[channelId] || 'default';
  const agentConfig = config.agents?.[agentId] || {};
  const maxTurns = agentConfig.maxTurns || SESSION_MAX_TURNS;

  if (maxTurns <= 0) return null;  // 0이면 비활성화
  if ((session.turnCount || 0) < maxTurns) return null;

  console.log(`🔄 세션 로테이션: ch=${channelId} turns=${session.turnCount} maxTurns=${maxTurns}`);

  // 현재 세션에서 요약 추출
  try {
    const summaryResult = await _runClaudeOnce(
      '지금까지 이 채널에서 나눈 대화의 핵심 내용을 3~5줄로 요약해줘. 중요한 결정사항, 작업 진행상황, 맥락을 포함해.',
      null, agent, session.sessionId
    );
    const summary = summaryResult.text || '';
    console.log(`📝 세션 요약 완료 (${summary.length}자)`);

    // 공유 노트에도 세션 요약 저장
    saveSessionSummaryToNotes(agentId, summary);

    // 세션 초기화 + 요약 저장
    channelSessions.set(channelId, {
      sessionId: null,
      lastUsed: Date.now(),
      turnCount: 0,
      summary: summary,
    });
    saveSessions();
    return summary;
  } catch (err) {
    console.log(`⚠️ 세션 요약 실패: ${err.message}, 요약 없이 리셋`);
    channelSessions.set(channelId, {
      sessionId: null,
      lastUsed: Date.now(),
      turnCount: 0,
      summary: null,
    });
    saveSessions();
    return null;
  }
}

function clearSession(channelId) {
  channelSessions.delete(channelId);
  saveSessions();
}

// 자기 검증 규칙 (모든 에이전트 공통)
// ── 자기 검증 규칙 (쓰기 권한 있는 에이전트만 주입) ──
const SELF_VERIFICATION_PROMPT = `## 자기 검증 규칙 (필수 준수)
코드 수정/생성 후 반드시 검증하세요. 통과할 때까지 완료 보고 금지.

1. **구문 검증**: Python \`py_compile\`, JS/TS \`node -c\` 또는 \`tsc --noEmit\`
2. **테스트 실행**: 관련 테스트 실행 (없으면 import 가능 여부 확인)
3. **실패 시 반복**: 실패 → 수정 → 재검증 (통과까지)
4. **결과 보고**: ✅ "검증 완료 — 구문 OK, 테스트 N개 통과" / ❌ "1차 실패 → [원인] → 수정 → 2차 통과"

예외: 문서/설정(MD/YAML/JSON) 수정은 구문만, 대화만 하면 검증 불필요.`;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash']);

function agentHasWriteTools(agent) {
  return (agent.allowedTools || []).some(t => WRITE_TOOLS.has(t));
}

// ── Discord 액션 (코어 — 모든 에이전트) ──
const DISCORD_CORE_PROMPT = `## Discord 액션 시스템 (내장 — 별도 도구 불필요)
다른 채널에 메시지 전송, 서버 관리 시 아래 JSON으로 응답 (코드블록 금지):
{"message": "사용자 메시지", "actions": [...]}

actions: sendMessage(channel,content), createChannel(name,channelType), deleteChannel(name), renameChannel(name,newName), createRole(name,color), deleteRole(name)

파일 전송: 응답에 [[FILE:/경로/파일]] 패턴 포함.

## 행동 규칙
- 확인 질문 없이 바로 실행. 큰 작업은 계획 보고 후 즉시 실행.
- Plan 모드 진입 금지. 바로 구현.
- 자기 채널 요청은 끝까지 책임. 떠넘기기 금지.
- 완료 시 수정 파일 목록 + 변경 요약 + 테스트 결과 포함.
- 봇 프로세스 관리: canRestartBot 권한이 있는 에이전트만 봇 재시작 가능합니다. 재시작 방법: launchctl bootout gui/$(id -u)/com.claude.discord.bot && sleep 2 && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.discord.bot.plist
- canRestartBot 권한이 없으면: kill, pkill, pgrep, killall, launchctl 등 프로세스 관리 명령어 절대 금지.
- config.json, .env, .sessions.json, PID 파일 삭제/초기화 금지.
- 대화/인사/안부는 도구 없이 바로 답변.
- 세션 연속: !reset까지 대화 이어감. "모르겠습니다" 금지.
- 한국어 응답. 영어 질문엔 영어. 코드블록에 언어 태그. Discord 마크다운 활용.`;

// ── 위임 시스템 (위임 가능 에이전트만 주입) ──
const DISCORD_DELEGATION_PROMPT = `## 에이전트 위임
작업이 다른 에이전트 전문 영역이면 JSON으로 위임:
단일: {"message": "응답", "delegate": {"agent": "ID", "task": "설명"}}
복수: {"message": "응답", "delegates": [{"agent": "ID1", "task": "작업1"}, {"agent": "ID2", "task": "작업2"}]}
결과 반환: "returnResult": true 추가.`;

// ── 시스템 프롬프트 빌더 (토큰 최적화) ──
function buildSystemPrompt(agent, agentId, agentConfig, sessionData) {
  let prompt = agent.systemPrompt;

  // 최적화 #5: 쓰기 권한 있는 에이전트만 검증 프롬프트 주입
  if (agentHasWriteTools(agent)) {
    prompt += '\n\n' + SELF_VERIFICATION_PROMPT;
  }

  // 최적화 #1: 코어 액션은 항상, 위임은 조건부
  prompt += '\n\n' + DISCORD_CORE_PROMPT;

  // 최적화 #2: 전체 38개 대신 같은 프로젝트 에이전트만 표시
  const proj = getProjectForAgent(agentId);
  const projectAgentIds = proj?.agents || [];
  const allAgents = Object.entries(agentConfig.agents || {}).filter(([id]) => id !== 'default');

  // 같은 프로젝트 에이전트 + hivemind/general (항상 포함)
  const alwaysInclude = new Set(['hivemind', 'general', agentId]);
  const relevantAgents = allAgents.filter(([id]) =>
    projectAgentIds.includes(id) || alwaysInclude.has(id)
  );

  if (relevantAgents.length > 0) {
    prompt += '\n\n' + DISCORD_DELEGATION_PROMPT;
    const agentList = relevantAgents
      .filter(([id]) => id !== agentId) // 자기 자신 제외
      .map(([id, a]) => `${a.avatar || '🤖'} ${a.name} → \`${id}\``)
      .join('\n');

    // 다른 프로젝트 에이전트도 있다는 힌트만
    const otherCount = allAgents.length - relevantAgents.length;
    const hint = otherCount > 0 ? `\n(다른 프로젝트 에이전트 ${otherCount}개는 hivemind를 통해 위임)` : '';
    prompt += `\n\n## 위임 가능한 에이전트\n${agentList}${hint}`;
  }

  // 최적화 #3: 공유 노트 — 경로만 알려주기 (장황한 설명 제거)
  const notesPath = getSharedNotesPath(agentId);
  if (notesPath) {
    prompt += `\n\n## 공유 노트: \`${notesPath}\`\n팀 협업 시 읽기/쓰기. JSON 형식, 자기 ID 키만 업데이트.`;
  }

  // 최적화 #4: 세션 요약 — 한 번만 주입 (summaryConsumed 플래그)
  if (sessionData?.summary && !sessionData?.sessionId && !sessionData?.summaryConsumed) {
    prompt += `\n\n## 이전 대화 요약\n${sessionData.summary}`;
    sessionData.summaryConsumed = true;
  }

  return prompt;
}

// ─────────────────────────────────────────
//  봇 준비
// ─────────────────────────────────────────
client.once('clientReady', () => {
  const config = loadConfig();
  const bindingCount = Object.keys(config.channelBindings).length;
  console.log(`✅ 봇 로그인 완료: ${client.user.tag}`);
  console.log(`📌 채널 바인딩: ${bindingCount}개`);
  console.log(`🤖 에이전트: ${Object.keys(config.agents).length}개`);
  console.log(`💾 세션: ${channelSessions.size}개 복원됨`);
  console.log(`📌 !claude <메시지>  — 일반 명령`);
  console.log(`🤖 !agent <명령>     — 에이전트 관리`);
  console.log(`🔗 !hook <명령>      — 훅 관리`);
  console.log(`💡 바인딩 채널에서는 자동 응답 (접두사 불필요)`);

  // 대시보드 초기화 (3초 후)
  setTimeout(() => setupDashboard(), 3000);
});

// ── 버튼 인터랙션 처리 ──
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  try {
    const handled = await handleDashboardButton(interaction);
    if (!handled && !interaction.replied) {
      await interaction.reply({ content: '알 수 없는 버튼입니다.', ephemeral: true });
    }
  } catch (err) {
    console.error('❌ 버튼 처리 오류:', err.message);
  }
});

// ── 연결 끊김 자동 복구 ──
client.on('error', (err) => {
  console.error('❌ Discord 클라이언트 오류:', err.message);
});
client.on('disconnect', () => {
  console.warn('⚠️ Discord 연결 끊김, 자동 재연결 시도...');
});
client.on('reconnecting', () => {
  console.log('🔄 Discord 재연결 중...');
});

// ─────────────────────────────────────────
//  메시지 처리
// ─────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── 대시보드 채널 메시지 자동 삭제 ──
  const isDashboardChannel = Array.from(dashboards.values()).some(d => d.channel?.id === message.channel.id);
  if (isDashboardChannel) {
    try { await message.delete(); } catch {}
    return;
  }

  // ── 중복 메시지 방지 ──
  if (processedMessages.has(message.id)) {
    console.log(`⚠️ 중복 메시지 무시: ${message.id}`);
    return;
  }
  markMessageProcessed(message.id);

  const content = message.content.trim();

  // ── !agent 명령 ──────────────────────────
  if (content.startsWith('!agent')) {
    await handleAgentCommand(message, content);
    return;
  }

  // ── !zai 명령 — Z.ai 에이전트 자동 생성 ──
  if (content.startsWith('!zai')) {
    await handleZaiSetup(message, content);
    return;
  }

  // ── !hook 명령 ───────────────────────────
  if (content.startsWith('!hook')) {
    await handleHookCommand(message, content);
    return;
  }

  // ── !project 명령 ──────────────────────────
  if (content.startsWith('!project')) {
    await handleProjectCommand(message, content);
    return;
  }

  // ── !reset / !새대화 — 대화 세션 초기화 ────
  if (content === '!reset' || content === '!새대화') {
    clearSession(message.channelId);
    // 큐도 비우기
    const queue = getQueue(message.channelId);
    const cleared = queue.length;
    queue.length = 0;
    await message.reply(`🔄 대화 세션이 초기화되었습니다.${cleared > 0 ? ` (대기열 ${cleared}개 취소)` : ''} 새로운 대화를 시작합니다.`);
    return;
  }

  // ── !stop / !중지 — 현재 작업 중단 (채널의 모든 활성 작업) ────
  if (content === '!stop' || content === '!중지') {
    const chId = message.channelId;
    let stopped = 0;
    for (const [tId, entry] of activeProcesses.entries()) {
      if (entry.channelId === chId && entry.proc) {
        try { entry.proc.kill('SIGTERM'); } catch {}
        stopped++;
      }
    }
    if (stopped > 0) {
      await message.reply(`⏹️ ${stopped}개 작업을 중단합니다.`);
    } else {
      await message.reply('현재 진행 중인 작업이 없습니다.');
    }
    return;
  }

  // ── !status — 에이전트 상태 확인 ────
  if (content === '!status' || content.startsWith('!status ')) {
    const targetName = content.replace('!status', '').trim();
    const config = loadConfig();
    const chId = message.channelId;

    // 특정 에이전트 지정 또는 현재 채널의 에이전트
    let statusAgentId = config.channelBindings?.[chId] || 'default';
    if (targetName) {
      // 이름이나 ID로 에이전트 찾기
      const found = Object.entries(config.agents || {}).find(([id, a]) =>
        id === targetName || a.name === targetName || a.name?.includes(targetName)
      );
      if (found) statusAgentId = found[0];
      else { await message.reply(`⚠️ 에이전트 '${targetName}'을(를) 찾을 수 없습니다.`); return; }
    }

    const statusAgent = config.agents?.[statusAgentId];
    if (!statusAgent) { await message.reply('⚠️ 에이전트를 찾을 수 없습니다.'); return; }

    // 바인딩 채널 찾기
    const boundChId = Object.entries(config.channelBindings || {}).find(([, id]) => id === statusAgentId)?.[0];

    // 현재 작업 상태
    const taskCount = boundChId ? getTaskCount(boundChId) : 0;
    const queueLen = boundChId ? getQueue(boundChId).length : 0;

    // 현재 도구 정보
    let currentTools = [];
    for (const [, proc] of activeProcesses) {
      if (proc.channelId === boundChId && proc.currentTool) currentTools.push(proc.currentTool);
      if (proc.agentId === statusAgentId && proc.currentTool) currentTools.push(proc.currentTool);
    }

    // 세션 정보
    const session = boundChId ? channelSessions.get(boundChId) : null;
    const turnCount = session?.turnCount || 0;

    // 최근 작업 통계 (24시간)
    const now = Date.now();
    const recentTasks = taskHistory.filter(t => now - t.timestamp < 24 * 60 * 60 * 1000);
    const avgDuration = recentTasks.length > 0
      ? Math.round(recentTasks.reduce((s, t) => s + t.durationMs, 0) / recentTasks.length / 1000)
      : 0;

    // 프로젝트 소속
    const proj = getProjectForAgent(statusAgentId);

    const statusLines = [
      `${statusAgent.avatar || '🤖'} **${statusAgent.name}** (\`${statusAgentId}\`)`,
      '',
      `📊 **상태**: ${taskCount > 0 ? `🟢 작업 중 (${taskCount}개)` : '⚪ 대기 중'}`,
      taskCount > 0 && currentTools.length > 0 ? `🔧 **현재**: ${currentTools.join(', ')}` : null,
      queueLen > 0 ? `📥 **대기열**: ${queueLen}개` : null,
      `💬 **세션**: ${turnCount}턴 ${session?.sessionId ? '(활성)' : '(없음)'}`,
      proj ? `📁 **프로젝트**: ${proj.name}` : null,
      `📈 **오늘 처리**: ${recentTasks.length}건${avgDuration > 0 ? ` (평균 ${avgDuration}초)` : ''}`,
      (() => {
        const ruleModel = getChannelModel(boundChId || chId);
        if (ruleModel) return `🧠 **모델**: ${ruleModel}`;
        return statusAgent.model ? `🧠 **모델**: ${statusAgent.model}` : null;
      })(),
    ].filter(Boolean);

    await message.reply(statusLines.join('\n'));
    return;
  }

  // ── !queue / !대기열 — 대기열 확인 ────
  if (content === '!queue' || content === '!대기열') {
    const queue = getQueue(message.channelId);
    if (queue.length === 0) {
      await message.reply('📭 대기열이 비어있습니다.');
    } else {
      const list = queue.map((q, i) => `${i + 1}. ${q.prompt.slice(0, 50)}${q.prompt.length > 50 ? '...' : ''}`).join('\n');
      await message.reply(`📬 대기열 (${queue.length}개):\n\`\`\`\n${list}\n\`\`\``);
    }
    return;
  }

  // ── !claude 명령 ─────────────────────────
  if (content.startsWith('!claude')) {
    await handleClaude(message, content);
    return;
  }

  // ── 자동 응답 모드 (바인딩 채널) ──────────
  const config = loadConfig();
  if (config.channelBindings[message.channelId]) {
    // 바인딩된 채널에서는 !claude 없이 자동 응답
    // 다른 ! 명령은 무시
    if (content.startsWith('!')) return;
    await handleClaude(message, '!claude ' + content);
    return;
  }
});

// ─────────────────────────────────────────
//  !claude 처리 (채널 바인딩 에이전트 적용)
// ─────────────────────────────────────────
async function handleClaude(message, content) {
  let prompt = content.slice('!claude'.length).trim();

  // 첨부파일 처리
  const attachedFiles = await handleAttachments(message);
  if (attachedFiles.length > 0) {
    const fileInfo = attachedFiles.map(f => {
      if (f.isText) {
        return `[첨부 텍스트 파일: ${f.name}]\n\`\`\`\n${f.textContent}\n\`\`\``;
      }
      return `[첨부 파일: ${f.name} → ${f.path}]`;
    }).join('\n\n');
    prompt = prompt ? `${fileInfo}\n\n${prompt}` : fileInfo;
  }

  if (!prompt) {
    await message.reply('사용법: `!claude <질문 또는 요청>` (또는 바인딩 채널에서 바로 메시지)');
    return;
  }

  // 채널에 바인딩된 에이전트 찾기
  const config = loadConfig();
  const channelId = message.channelId;
  const agentId = config.channelBindings[channelId] || 'default';
  const agent = { ...(config.agents[agentId] || config.agents['default']) };

  // ── Agent Rules: 채널별 모델 라우팅 ──
  const channelModel = getChannelModel(channelId);
  let _routingLabel = null;  // 스마트 라우팅 결과 라벨 (진행 메시지에 표시)

  // 1) 에스컬레이션 최우선 — 이전 요청에서 exclusive_file 수정으로 플래그 설정된 경우
  const prevSession = channelSessions.get(channelId);
  if (prevSession?._escalateNext) {
    const escModel = prevSession._escalateNext;
    delete prevSession._escalateNext;
    const escTier = resolveModelTier(escModel);
    if (escTier) {
      agent.model = escTier.cliModel;
      if (agent.backend === 'zai') delete agent.backend;
      _routingLabel = `Opus (에스컬레이션)`;
      console.log(`⚡ [에스컬레이션] ch=${channelId} → ${escModel}`);
    }
  }
  // 2) 스마트 라우팅 — 프롬프트 분석 (에스컬레이션 없을 때만)
  else if (channelModel) {
    const smartResult = smartRouteModel(prompt, channelModel);
    if (smartResult) {
      // 스마트 라우팅 결정 → 해당 모델 적용
      const tier = resolveModelTier(smartResult.model);
      if (tier) {
        // Z.ai 백엔드는 키가 있을 때만 사용
        if (tier.backend === 'zai' && !isBackendAvailable('zai')) {
          console.log(`⚠️ [라우팅] Z.ai 키 없음 → 기본 모델 유지`);
        } else {
          agent.model = tier.cliModel;
          if (tier.backend === 'zai') {
            agent.backend = 'zai';
            agent.zaiModel = tier.zaiModel;
          } else if (agent.backend === 'zai') {
            delete agent.backend;
          }
          _routingLabel = smartResult.label;
          console.log(`🧠 [스마트 라우팅] ch=${channelId} → ${smartResult.model} (${smartResult.reason}: ${smartResult.label})`);
        }
      }
    } else {
      // 판단 불가 → 채널 기본 모델
      const tier = resolveModelTier(channelModel);
      if (tier) {
        // Z.ai 백엔드는 키가 있을 때만 사용
        if (tier.backend === 'zai' && !isBackendAvailable('zai')) {
          console.log(`⚠️ [라우팅] Z.ai 키 없음 → 기본 모델 유지`);
        } else {
          agent.model = tier.cliModel;
          if (tier.backend === 'zai') {
            agent.backend = 'zai';
            agent.zaiModel = tier.zaiModel;
          } else if (agent.backend === 'zai') {
            delete agent.backend;
          }
          console.log(`📐 [모델 라우팅] ch=${channelId} → ${channelModel} (채널 기본)`);
        }
      }
    }
  }

  // 스마트 라우팅 라벨이 없으면 현재 모델 기반으로 자동 생성
  if (!_routingLabel) {
    const finalModel = agent.model || 'opus';
    _routingLabel = getModelDisplayLabel(finalModel);
  }

  // 채널 단위 동시 실행 제어 — 최대 동시 작업 수 초과 시 큐에 추가
  const currentTasks = getTaskCount(channelId);
  if (currentTasks >= MAX_CONCURRENT_PER_CHANNEL) {
    const queue = getQueue(channelId);
    if (queue.length >= MAX_QUEUE_SIZE) {
      await message.reply(`⚠️ 대기열이 가득 찼습니다 (최대 ${MAX_QUEUE_SIZE}개). 현재 작업 완료 후 다시 시도해주세요.`);
      return;
    }
    queue.push({ message, prompt });
    const pos = queue.length;
    await message.reply(`📥 메시지 접수 (${pos}번째) — 현재 작업 완료 후 이어서 처리합니다. 이전 작업 컨텍스트를 참고합니다.\n💡 \`!stop\`으로 현재 작업 중단, \`!queue\`로 대기열 확인`);
    return;
  }

  const taskId = `${channelId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  incrementTaskCount(channelId);

  // ── 실시간 진행 현황 시스템 ──
  const agentLabel = agentId !== 'default' ? `${agent.avatar} ${agent.name}` : '🤖 Claude';
  let alreadyCleaned = false;  // 위임 시 조기 정리 플래그

  // 프로세스 추적 (외부에서 !stop으로 중단 가능)
  activeProcesses.set(taskId, { proc: null, agentLabel, channelId });
  updateDashboard();   // 대시보드 갱신
  const startTime = Date.now();
  const toolSteps = [];    // 도구 사용 로그
  let lastEditTime = 0;    // 디스코드 메시지 수정 쓰로틀

  // 진행 상황 임베드 생성
  const makeProgressEmbed = () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const timeStr = min > 0 ? `${min}분 ${sec}초` : `${sec}초`;

    const statusIcon = toolSteps.length === 0 ? '💭' :
                       toolSteps[toolSteps.length - 1]?.tool === 'Bash' ? '💻' :
                       toolSteps[toolSteps.length - 1]?.tool === 'Write' || toolSteps[toolSteps.length - 1]?.tool === 'Edit' ? '✏️' :
                       '🔍';

    let description = `${statusIcon} `;
    if (toolSteps.length === 0) description += '요청을 분석하고 있습니다...';
    else description += `작업 진행 중... (도구 ${toolSteps.length}회 사용)`;

    // 최근 도구 로그 (최대 8개)
    if (toolSteps.length > 0) {
      const recent = toolSteps.slice(-8);
      const lines = recent.map((s, i) => {
        const prefix = i === recent.length - 1 ? '└──' : '├──';
        return `${prefix} ${s.icon} ${s.tool}${s.detail ? ': ' + s.detail : ''}`;
      });
      if (toolSteps.length > 8) lines.unshift(`... +${toolSteps.length - 8}개 이전 작업`);
      description += '\n```\n' + lines.join('\n') + '\n```';
    }

    const footerText = `⏱️ ${timeStr} 경과 | 🧠 ${_routingLabel}`;

    return {
      color: 0x8B5CF6,
      author: { name: `${agentLabel} 작업 중...` },
      description,
      footer: { text: footerText },
    };
  };

  // 진행 메시지 생성
  let progressMsg = null;
  try {
    progressMsg = await message.channel.send({ embeds: [makeProgressEmbed()] });
  } catch {}

  // 타이핑 표시 유지
  let typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 5000);
  await message.channel.sendTyping();

  // 진행 메시지 업데이트 (3초마다)
  const progressInterval = setInterval(async () => {
    if (!progressMsg) return;
    const now = Date.now();
    if (now - lastEditTime < 2500) return;
    lastEditTime = now;
    try { await progressMsg.edit({ embeds: [makeProgressEmbed()] }); } catch {}
  }, 3000);

  // 도구 사용 콜백 (Claude 실행 중 실시간 호출됨)
  const TOOL_ICONS = {
    Read: '📖', Write: '📝', Edit: '✏️', Bash: '💻',
    Grep: '🔎', Glob: '📂', Agent: '🤖', WebSearch: '🌐',
    WebFetch: '🌐', TodoWrite: '📋', NotebookEdit: '📓',
  };

  let _escalatedToOpus = false;

  const onToolUse = (toolName, input) => {
    const icon = TOOL_ICONS[toolName] || '⚙️';
    let detail = '';

    // 도구별 요약 추출
    if (input) {
      if (input.file_path) detail = input.file_path.split('/').slice(-2).join('/');
      else if (input.command) detail = input.command.length > 50 ? input.command.slice(0, 47) + '...' : input.command;
      else if (input.pattern) detail = `"${input.pattern}"`;
      else if (input.query) detail = input.query.length > 40 ? input.query.slice(0, 37) + '...' : input.query;
      else if (input.content && input.file_path) detail = input.file_path.split('/').pop();
    }

    // ── exclusive_files 수정 감지 → 다음 요청 opus 에스컬레이션 ──
    if (!_escalatedToOpus && (toolName === 'Edit' || toolName === 'Write') && input?.file_path) {
      if (isExclusiveFile(input.file_path)) {
        const opusTier = loadAgentRules().model_tiers?.opus;
        if (opusTier?.id) {
          _escalatedToOpus = true;
          console.log(`⚡ [에스컬레이션] exclusive_file 수정: ${input.file_path} → 다음 요청 ${opusTier.id}`);
          const session = channelSessions.get(channelId);
          if (session) session._escalateNext = opusTier.id;
        }
      }
    }

    toolSteps.push({ icon, tool: toolName, detail });
    // 대시보드용 현재 작업 업데이트
    const proc = activeProcesses.get(taskId);
    if (proc) proc.currentTool = `${icon} ${toolName}${detail ? ': ' + detail.slice(0, 30) : ''}`;
    console.log(`  📊 [${agentLabel}] ${icon} ${toolName}${detail ? ': ' + detail : ''}`);
  };

  try {
    // 세션 턴 수 초과 시 자동 요약 + 리셋
    await maybeRotateSession(channelId, agent);

    // 토큰 최적화된 시스템 프롬프트 빌드
    const agentConfig = loadConfig();
    const sessionData = channelSessions.get(channelId);
    let systemPrompt = buildSystemPrompt(agent, agentId, agentConfig, sessionData);

    // 대화 세션 연속성 — 이전 세션 이어가기
    let sessionId = getSessionId(channelId);
    let result;

    // 프로세스 참조 추적 (외부 중단용)
    const onProcSpawn = (proc) => {
      const entry = activeProcesses.get(taskId);
      if (entry) entry.proc = proc;
    };

    try {
      result = await runClaude(prompt, systemPrompt, agent, sessionId, onToolUse, onProcSpawn);
    } catch (error) {
      // 세션 손상 또는 복원 실패 → 세션 리셋 후 재시도
      if (sessionId && (error.isSessionError || error.message?.includes('signature') || error.message?.includes('400'))) {
        console.log(`⚠️ 세션 손상 감지 (${sessionId.slice(0, 8)}...), 세션 리셋 후 재시도: ${error.message?.slice(0, 80)}`);
        clearSession(channelId);
        result = await runClaude(prompt, systemPrompt, agent, null, onToolUse, onProcSpawn);
      } else if (sessionId) {
        console.log(`⚠️ 세션 복원 실패 (${sessionId.slice(0, 8)}...), 새 세션으로 재시도: ${error.message}`);
        clearSession(channelId);
        result = await runClaude(prompt, systemPrompt, agent, null, onToolUse, onProcSpawn);
      } else {
        throw error;
      }
    }

    // 세션 ID 저장 → 다음 메시지에서 이어가기
    if (result.sessionId) {
      setSessionId(channelId, result.sessionId);
      console.log(`💾 세션 저장: ch=${channelId} session=${result.sessionId.slice(0, 8)}...`);
    }

    const rawResponse = result.text;

    // 진행 메시지 → 완료 상태로 업데이트
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const timeStr = min > 0 ? `${min}분 ${sec}초` : `${sec}초`;

    // 완료 임베드 구성 — 결과 미리보기 포함
    const resultPreview = rawResponse
      ? (rawResponse.length > 200 ? rawResponse.slice(0, 200) + '...' : rawResponse)
      : null;

    if (progressMsg) {
      try {
        const completionDesc = [];
        if (toolSteps.length > 0) completionDesc.push(`✅ 도구 ${toolSteps.length}회 사용하여 완료`);
        else completionDesc.push('✅ 완료');

        // 사용된 도구 요약
        if (toolSteps.length > 0) {
          const toolCounts = {};
          for (const s of toolSteps) {
            toolCounts[s.tool] = (toolCounts[s.tool] || 0) + 1;
          }
          const toolSummary = Object.entries(toolCounts)
            .map(([t, c]) => `${TOOL_ICONS[t] || '⚙️'} ${t} ×${c}`)
            .join('  ');
          completionDesc.push(toolSummary);
        }

        await progressMsg.edit({ embeds: [{
          color: 0x22C55E,
          author: { name: `${agentLabel} 작업 완료` },
          description: completionDesc.join('\n'),
          footer: { text: `⏱️ ${timeStr} 소요 | 🧠 ${_routingLabel}` },
        }] });
      } catch {}
    }

    // 빈 응답 처리 — 도구 사용 후 텍스트 없는 경우 자동 후속 호출
    if (!rawResponse || !rawResponse.trim()) {
      console.log(`⚠️ Claude 빈 응답 (session=${result.sessionId?.slice(0, 8) || 'none'}, tools=${toolSteps.length})`);
      if (toolSteps.length > 0 && result.sessionId) {
        // 세션 이어서 결과 요약 요청 (최대 2회 재시도)
        for (let retry = 0; retry < 2; retry++) {
          console.log(`🔄 빈 응답 → 후속 요약 요청 (${retry + 1}/2)`);
          try {
            const followUp = await _runClaudeOnce(
              '방금 수행한 작업의 결과를 한국어로 간결하게 요약해서 알려주세요. 반드시 텍스트로 답변하세요.',
              DISCORD_CORE_PROMPT, agentConfig, result.sessionId
            );
            if (followUp.text && followUp.text.trim()) {
              await sendResponseWithFiles(message, followUp.text);
              return;
            }
          } catch (e) {
            console.log(`⚠️ 후속 요약 실패 (${retry + 1}/2): ${e.message}`);
          }
        }
        // 후속도 실패하면 도구 요약 표시
        const toolSummary = toolSteps.slice(-5).map(s => `${s.icon} ${s.tool}${s.detail ? ': ' + s.detail : ''}`).join('\n');
        await message.reply(`작업을 수행했습니다.\n\`\`\`\n${toolSummary}\n\`\`\``);
      } else {
        await message.reply('응답을 생성하지 못했습니다. 다시 시도해주세요.');
      }
      return;
    }

    // 🤝 에이전트 위임 감지
    const delegated = await handleDelegation(rawResponse, message);
    if (delegated) return;  // 위임 처리 완료

    const result2 = tryParseJSON(rawResponse);

    if (result2) {
      const { parsed: pj, before, after } = result2;

      // 위임 처리 (단일: delegate, 복수: delegates)
      const delegations = pj.delegates
        ? pj.delegates
        : pj.delegate
          ? [pj.delegate]
          : null;

      if (delegations && delegations.length > 0) {
        // ① 답변 먼저 (사용자에게 즉시 보여줌)
        const targetNames = delegations.map(d => d.agent).join(', ');
        const delegateMsg = pj.message || before || `${targetNames} 에이전트에게 위임합니다.`;
        console.log(`🤝 위임 답변 전송 (${delegations.length}건): ${delegateMsg.slice(0, 80)}`);
        try {
          await message.reply(delegateMsg);
        } catch (e) {
          console.log(`⚠️ 위임 답변 전송 실패: ${e.message}`);
        }

        // ② 라우터 즉시 정리 (finally에서 이중 정리 방지)
        alreadyCleaned = true;
        clearInterval(typingInterval);
        clearInterval(progressInterval);
        decrementTaskCount(channelId);
        activeProcesses.delete(taskId);

        // ③ 라우터 진행 임베드 → 완료
        if (progressMsg) {
          try {
            const delegateDesc = delegations.map(d => `🤝 → ${d.agent}`).join('\n');
            await progressMsg.edit({ embeds: [{
              color: 0x22C55E,
              author: { name: `${agentLabel} 위임 완료` },
              description: `${delegateDesc}\n📊 ${delegations.length}개 에이전트 동시 위임`,
              footer: { text: `⏱️ ${timeStr} 소요 | 🧠 ${_routingLabel}` },
            }] });
          } catch {}
        }

        // ④ 모든 위임 동시 실행 (병렬 — 라우터는 여기서 끝)
        const src = getAgentForChannel(channelId);
        const sourceChannel = message.channel;
        for (const d of delegations) {
          if (d.agent && d.task) {
            // returnResult: true면 위임 결과를 원래 채널에 보고
            delegateToAgent(src?.name || agentLabel, d.agent, d.task, message)
              .then(result => {
                if (d.returnResult && result?.text) {
                  const agentName = config.agents?.[d.agent]?.name || d.agent;
                  const summary = result.text.length > 1500
                    ? result.text.slice(0, 1500) + '...(생략)'
                    : result.text;
                  sourceChannel.send(`📋 **${agentName}** 작업 결과:\n${summary}`).catch(() => {});
                }
              })
              .catch(() => {});
          }
        }
        return;
      }

      // 일반 JSON 처리 (위임 없는 경우)
      if (before) await sendResponseWithFiles(message, before);
      if (pj.message) await sendResponseWithFiles(message, pj.message);
      if (pj.actions?.length > 0) await executeActions(message, pj.actions);
      if (after) await sendResponseWithFiles(message, after);
    } else {
      await sendResponseWithFiles(message, rawResponse);
    }
  } catch (error) {
    console.error('오류:', error.message);

    // 진행 메시지 → 에러 상태로 업데이트
    if (progressMsg) {
      try {
        await progressMsg.edit({ embeds: [{
          color: 0xEF4444,
          author: { name: `${agentLabel} 오류 발생` },
          description: `❌ ${error.message}`,
          footer: { text: `도구 ${toolSteps.length}회 사용 | 🧠 ${_routingLabel}` },
        }] });
      } catch {}
    }

    const errorMsg = `❌ 오류: ${error.message}`;
    await message.reply(errorMsg);
  } finally {
    clearInterval(typingInterval);
    clearInterval(progressInterval);
    if (!alreadyCleaned) {
      decrementTaskCount(channelId);
      activeProcesses.delete(taskId);
    }
    totalProcessed++;
    const durationMs = Date.now() - startTime;
    taskHistory.push({ timestamp: Date.now(), durationMs });
    // 48시간 이상 된 기록 제거
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    while (taskHistory.length > 0 && taskHistory[0].timestamp < cutoff) taskHistory.shift();
    updateDashboard();   // 대시보드 즉시 갱신

    // 큐에 대기 중인 메시지 처리
    const queue = getQueue(channelId);
    if (queue.length > 0) {
      // 약간의 딜레이 후 다음 메시지 처리 (연속 호출 방지)
      setTimeout(() => processNextInQueue(channelId), 1000);
    }
  }
}

// ─────────────────────────────────────────
//  첨부파일 다운로드
// ─────────────────────────────────────────
async function handleAttachments(message) {
  const files = [];
  if (!message.attachments || message.attachments.size === 0) return files;

  for (const att of message.attachments.values()) {
    try {
      const timestamp = Date.now();
      const safeName = `${timestamp}_${att.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const tmpPath = path.join(TMP_DIR, safeName);

      // HTTP 다운로드
      await downloadFile(att.url, tmpPath);

      const isText = isTextFile(att.name, att.contentType);
      let textContent = '';
      if (isText) {
        try {
          textContent = fs.readFileSync(tmpPath, 'utf-8');
          // 텍스트가 너무 길면 잘라냄
          if (textContent.length > 10000) {
            textContent = textContent.slice(0, 10000) + '\n... (10,000자 이후 생략)';
          }
        } catch (e) {
          // 바이너리인 경우 무시
        }
      }

      files.push({
        name: att.name,
        path: tmpPath,
        type: att.contentType,
        size: att.size,
        isText,
        textContent,
      });

      console.log(`📎 첨부파일 다운로드: ${att.name} → ${tmpPath} (${att.size} bytes)`);
    } catch (err) {
      console.error(`첨부파일 다운로드 실패: ${att.name}`, err.message);
    }
  }

  return files;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);

    protocol.get(url, (response) => {
      // 리다이렉트 처리
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function isTextFile(filename, contentType) {
  const textExtensions = [
    '.txt', '.md', '.py', '.js', '.ts', '.json', '.yaml', '.yml',
    '.toml', '.cfg', '.ini', '.sh', '.bash', '.zsh', '.csv', '.log',
    '.html', '.css', '.xml', '.sql', '.env', '.gitignore', '.conf',
    '.jsx', '.tsx', '.vue', '.svelte', '.rs', '.go', '.java', '.rb',
    '.php', '.c', '.cpp', '.h', '.hpp',
  ];
  const ext = path.extname(filename).toLowerCase();
  if (textExtensions.includes(ext)) return true;
  if (contentType && contentType.startsWith('text/')) return true;
  return false;
}

// ─────────────────────────────────────────
//  !agent 명령 처리
// ─────────────────────────────────────────
async function handleAgentCommand(message, content) {
  const parts = content.split(' ');
  const sub = parts[1];
  const config = loadConfig();

  switch (sub) {

    // !agent list — 에이전트 목록
    case 'list': {
      const lines = Object.entries(config.agents).map(([id, a]) => {
        const boundChannels = Object.entries(config.channelBindings)
          .filter(([, aid]) => aid === id)
          .map(([cid]) => `<#${cid}>`)
          .join(', ') || '없음';
        const wdir = a.workingDir ? `\`${path.basename(a.workingDir)}/\`` : '없음';
        return `${a.avatar} **${a.name}** (\`${id}\`) — 바인딩: ${boundChannels} | 경로: ${wdir}`;
      });
      await sendResponse(message, `**에이전트 목록 (${Object.keys(config.agents).length}개):**\n${lines.join('\n')}`);
      break;
    }

    // !agent create <id> <이름> | <시스템프롬프트>
    case 'create': {
      const rest = parts.slice(2).join(' ');
      const [idAndName, ...promptParts] = rest.split('|');
      const [id, ...nameParts] = idAndName.trim().split(' ');
      const name = nameParts.join(' ').trim();
      const systemPrompt = promptParts.join('|').trim();

      if (!id || !name || !systemPrompt) {
        await message.reply('사용법: `!agent create <id> <이름> | <시스템프롬프트>`\n예) `!agent create helper 친절한봇 | 당신은 친절한 도우미입니다`');
        break;
      }

      config.agents[id] = {
        name,
        avatar: '🤖',
        systemPrompt,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
        timeout: 300000,
      };
      saveConfig(config);
      await message.reply(`✅ 에이전트 **${name}** (\`${id}\`) 생성 완료!`);
      break;
    }

    // !agent delete <id>
    case 'delete': {
      const id = parts[2];
      if (!id || id === 'default') { await message.reply('❌ 에이전트 ID를 입력하세요. (default는 삭제 불가)'); break; }
      if (!config.agents[id]) { await message.reply(`❌ \`${id}\` 에이전트가 없습니다.`); break; }
      delete config.agents[id];
      // 바인딩도 제거
      for (const [cid, aid] of Object.entries(config.channelBindings)) {
        if (aid === id) delete config.channelBindings[cid];
      }
      saveConfig(config);
      await message.reply(`✅ \`${id}\` 에이전트 삭제 완료`);
      break;
    }

    // !agent bind #채널 <agentId>
    case 'bind': {
      const channelMention = parts[2];
      const agentId = parts[3];
      const channelId = channelMention?.replace(/[<#>]/g, '');

      if (!channelId || !agentId) {
        await message.reply('사용법: `!agent bind #채널 <에이전트ID>`\n예) `!agent bind #코딩방 coder`');
        break;
      }
      if (!config.agents[agentId]) {
        await message.reply(`❌ \`${agentId}\` 에이전트가 없습니다. \`!agent list\`로 확인하세요.`);
        break;
      }

      config.channelBindings[channelId] = agentId;
      saveConfig(config);
      const agent = config.agents[agentId];
      await message.reply(`✅ <#${channelId}> → **${agent.name}** 바인딩 완료!\n이 채널에서 메시지를 보내면 ${agent.avatar} **${agent.name}**가 자동 응답합니다.`);
      break;
    }

    // !agent unbind #채널
    case 'unbind': {
      const channelMention = parts[2];
      const channelId = channelMention?.replace(/[<#>]/g, '');
      if (!channelId) { await message.reply('사용법: `!agent unbind #채널`'); break; }
      delete config.channelBindings[channelId];
      saveConfig(config);
      await message.reply(`✅ <#${channelId}> 바인딩 해제 완료`);
      break;
    }

    // !agent info <id>
    case 'info': {
      const id = parts[2];
      const agent = config.agents[id];
      if (!agent) { await message.reply(`❌ \`${id}\` 에이전트가 없습니다.`); break; }
      const tools = agent.allowedTools?.join(', ') || '없음';
      const wdir = agent.workingDir || '없음';
      const timeout = agent.timeout ? `${agent.timeout / 1000}초` : '기본';
      await message.reply(
        `**${agent.avatar} ${agent.name}** (\`${id}\`)\n` +
        `**작업 경로:** \`${wdir}\`\n` +
        `**허용 도구:** ${tools}\n` +
        `**타임아웃:** ${timeout}\n` +
        `**시스템 프롬프트:**\n\`\`\`\n${agent.systemPrompt.slice(0, 800)}\n\`\`\``
      );
      break;
    }

    // !agent setdir <id> <경로>
    case 'setdir': {
      const id = parts[2];
      const dir = parts.slice(3).join(' ');
      if (!id || !dir) { await message.reply('사용법: `!agent setdir <id> <작업경로>`'); break; }
      if (!config.agents[id]) { await message.reply(`❌ \`${id}\` 에이전트가 없습니다.`); break; }
      config.agents[id].workingDir = dir;
      saveConfig(config);
      await message.reply(`✅ \`${id}\` 작업 경로 → \`${dir}\``);
      break;
    }

    default:
      await message.reply(
        '**에이전트 명령어:**\n' +
        '`!agent list` — 에이전트 목록\n' +
        '`!agent create <id> <이름> | <시스템프롬프트>` — 에이전트 생성\n' +
        '`!agent delete <id>` — 에이전트 삭제\n' +
        '`!agent bind #채널 <id>` — 채널에 에이전트 바인딩\n' +
        '`!agent unbind #채널` — 채널 바인딩 해제\n' +
        '`!agent info <id>` — 에이전트 상세 정보\n' +
        '`!agent setdir <id> <경로>` — 작업 경로 변경'
      );
  }
}

// ─────────────────────────────────────────
//  !project 명령 처리 (프로젝트 관리)
// ─────────────────────────────────────────
async function handleProjectCommand(message, content) {
  const parts = content.split(/\s+/);
  const sub = parts[1];

  if (sub === 'create' || sub === '생성') {
    // !project create <id> <이름> <이모지>
    // 예: !project create myproj "My Project" 🚀
    const projId = parts[2];
    if (!projId) {
      return message.reply('사용법: `!project create <ID> <이름> <이모지>`\n예: `!project create trading "트레이딩 봇" 📈`');
    }
    const emoji = parts[parts.length - 1]?.match(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/u) ? parts[parts.length - 1] : '📁';
    // 이모지가 마지막이면 이름은 3 ~ length-2, 아니면 3 ~ 끝
    const hasEmoji = emoji !== '📁';
    const nameTokens = hasEmoji ? parts.slice(3, parts.length - 1) : parts.slice(3);
    const projName = nameTokens.join(' ') || projId;

    const config = loadConfig();
    if (!config.projects) config.projects = {};
    if (config.projects[projId]) {
      return message.reply(`❌ 프로젝트 \`${projId}\`는 이미 존재합니다.`);
    }

    config.projects[projId] = { name: projName, emoji, agents: [] };
    saveConfig(config);

    // 대시보드 생성 여부 질문 (버튼)
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dash_yes_${projId}`).setLabel('대시보드 만들기').setStyle(ButtonStyle.Success).setEmoji('📊'),
      new ButtonBuilder().setCustomId(`dash_no_${projId}`).setLabel('나중에').setStyle(ButtonStyle.Secondary),
    );

    await message.reply({
      content: `✅ 프로젝트 **${emoji} ${projName}** (\`${projId}\`) 생성 완료!\n\n이 프로젝트의 실시간 대시보드 채널을 만들까요?`,
      components: [row],
    });

  } else if (sub === 'list' || sub === '목록') {
    const config = loadConfig();
    const projects = config.projects || {};
    if (Object.keys(projects).length === 0) {
      // 자동 분류 표시
      const allAgents = Object.keys(config.agents || {}).filter(id => id !== 'default');
      const ccCount = allAgents.filter(id => id.startsWith('cc_')).length;
      const omCount = allAgents.length - ccCount;
      return message.reply(`📁 등록된 프로젝트 없음 (자동 분류 중)\n🧠 Overmind: ${omCount}개 에이전트\n🎬 Command Center: ${ccCount}개 에이전트`);
    }
    const lines = Object.entries(projects).map(([id, p]) => {
      const agentCount = (p.agents || []).length;
      return `${p.emoji} **${p.name}** (\`${id}\`) — 에이전트 ${agentCount}개`;
    });
    await message.reply(`📁 **프로젝트 목록**\n\n${lines.join('\n')}`);

  } else if (sub === 'delete' || sub === '삭제') {
    const projId = parts[2];
    if (!projId) return message.reply('사용법: `!project delete <ID>`');
    const config = loadConfig();
    if (!config.projects || !config.projects[projId]) {
      return message.reply(`❌ 프로젝트 \`${projId}\`를 찾을 수 없습니다.`);
    }
    const proj = config.projects[projId];
    delete config.projects[projId];
    saveConfig(config);

    // 대시보드 채널도 삭제
    if (dashboards.has(projId)) {
      const dash = dashboards.get(projId);
      try { await dash.channel.delete('프로젝트 삭제'); } catch {}
      dashboards.delete(projId);
    }
    await message.reply(`🗑️ 프로젝트 **${proj.emoji} ${proj.name}** 삭제 완료`);

  } else if (sub === 'addagent' || sub === '에이전트추가') {
    // !project addagent <projId> <agentId>
    const projId = parts[2];
    const agentId = parts[3];
    if (!projId || !agentId) return message.reply('사용법: `!project addagent <프로젝트ID> <에이전트ID>`');
    const config = loadConfig();
    if (!config.projects?.[projId]) return message.reply(`❌ 프로젝트 \`${projId}\`를 찾을 수 없습니다.`);
    if (!config.agents?.[agentId]) return message.reply(`❌ 에이전트 \`${agentId}\`를 찾을 수 없습니다.`);
    if (!config.projects[projId].agents) config.projects[projId].agents = [];
    if (config.projects[projId].agents.includes(agentId)) return message.reply(`⚠️ 이미 추가되어 있습니다.`);
    config.projects[projId].agents.push(agentId);
    saveConfig(config);
    await message.reply(`✅ **${config.agents[agentId].name}** → **${config.projects[projId].name}** 추가 완료`);

  } else {
    await message.reply(
      '📁 **프로젝트 명령어**\n\n' +
      '`!project create <ID> <이름> <이모지>` — 프로젝트 생성\n' +
      '`!project list` — 프로젝트 목록\n' +
      '`!project delete <ID>` — 프로젝트 삭제\n' +
      '`!project addagent <프로젝트ID> <에이전트ID>` — 에이전트 추가'
    );
  }
}

// ── 대시보드 버튼 인터랙션 처리 ──
async function handleDashboardButton(interaction) {
  const customId = interaction.customId;
  if (!customId.startsWith('dash_')) return false;

  const [, action, projId] = customId.split('_');
  const config = loadConfig();
  const proj = config.projects?.[projId];
  if (!proj) {
    await interaction.reply({ content: '❌ 프로젝트를 찾을 수 없습니다.', ephemeral: true });
    return true;
  }

  if (action === 'yes') {
    // 대시보드 채널 생성
    const guild = interaction.guild;
    const channelName = `📊-${proj.name.toLowerCase().replace(/\s+/g, '-')}`;

    let channel = guild.channels.cache.find(ch => ch.name === channelName && ch.type === ChannelType.GuildText);
    if (!channel) {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `${proj.emoji} ${proj.name} 에이전트 실시간 대시보드`,
        reason: '프로젝트 대시보드 생성',
      });
    }

    const embed = buildProjectEmbed(projId, proj, config);
    const msg = await channel.send({ embeds: [embed] });
    try { await msg.pin(); } catch {}
    dashboards.set(projId, { channel, message: msg, lastState: '', project: proj });

    // 대시보드 채널 메시지 자동 삭제 등록
    const dashChannelIds = new Set([...dashboards.values()].map(d => d.channel.id));
    // 기존 리스너는 setupDashboard에서 등록됨, 새 채널은 ID 비교로 자동 포함

    await interaction.update({
      content: `✅ 대시보드 채널 <#${channel.id}> 생성 완료! 5초마다 자동 업데이트됩니다.`,
      components: [],
    });
  } else {
    await interaction.update({
      content: `📁 프로젝트 **${proj.emoji} ${proj.name}** 생성 완료! 대시보드는 나중에 만들 수 있습니다.`,
      components: [],
    });
  }
  return true;
}

// ─────────────────────────────────────────
//  !zai 명령 — Z.ai 에이전트 원클릭 생성
// ─────────────────────────────────────────
async function handleZaiSetup(message, content) {
  const apiKey = content.replace('!zai', '').trim();
  if (!apiKey) {
    await message.reply('사용법: `!zai <Z.ai API 키>`\n\nZ.ai 에이전트 + 채널이 자동 생성됩니다.\nAPI 키는 https://z.ai/manage-apikey 에서 발급받으세요.');
    return;
  }

  const config = loadConfig();
  const guild = message.guild;
  if (!guild) return;

  await message.reply('🧿 Z.ai 설정 시작...');

  try {
    // 1. .env에 ZAI_API_KEY 저장
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch {}
    if (envContent.includes('ZAI_API_KEY=')) {
      envContent = envContent.replace(/ZAI_API_KEY=.*/g, `ZAI_API_KEY=${apiKey}`);
    } else {
      envContent += `\nZAI_API_KEY=${apiKey}`;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n');
    process.env.ZAI_API_KEY = apiKey;

    // 2. 에이전트 생성 (없으면)
    if (!config.agents) config.agents = {};
    if (!config.agents.zai) {
      config.agents.zai = {
        name: 'Z.ai',
        avatar: '🧿',
        systemPrompt: '당신은 Z.ai GLM-5 기반 AI 어시스턴트입니다. 한국어로 답변하세요. 요청에 대해 확인 질문 없이 바로 실행하고, 결과를 구체적으로 알려주세요.',
        workingDir: process.cwd(),
        backend: 'zai',
        zaiModel: 'glm-5',
        model: 'opus',
      };
    }

    // 3. 채널 생성 (없으면)
    let zaiChannel = guild.channels.cache.find(
      ch => ch.name.includes('zai') && ch.type === 0
    );
    if (!zaiChannel) {
      zaiChannel = await guild.channels.create({
        name: '🧿z-ai',
        type: 0, // GuildText
        topic: 'Z.ai GLM-5 에이전트 — 자동 생성됨',
      });
    }

    // 4. 채널 바인딩
    if (!config.channelBindings) config.channelBindings = {};
    config.channelBindings[zaiChannel.id] = 'zai';

    // 5. config 저장
    saveConfig(config);

    // 6. 원본 메시지 삭제 (API 키 노출 방지)
    try { await message.delete(); } catch {}

    await message.channel.send(
      `✅ Z.ai 설정 완료!\n\n` +
      `🧿 **에이전트**: Z.ai (GLM-5)\n` +
      `💬 **채널**: <#${zaiChannel.id}>\n\n` +
      `해당 채널에서 바로 대화하면 GLM-5가 응답합니다.`
    );

    console.log(`🧿 Z.ai 설정 완료: agent=zai_hivemind channel=${zaiChannel.id}`);
  } catch (err) {
    await message.reply(`❌ Z.ai 설정 실패: ${err.message}`);
    console.error('Z.ai 설정 오류:', err);
  }
}

// ─────────────────────────────────────────
//  !hook 명령 처리 (관리자 훅)
// ─────────────────────────────────────────
async function handleHookCommand(message, content) {
  const parts = content.split(' ');
  const sub = parts[1];
  const config = loadConfig();

  switch (sub) {

    // !hook list — 훅 목록
    case 'list': {
      const hooks = config.hooks || {};
      if (Object.keys(hooks).length === 0) {
        await message.reply('등록된 훅이 없습니다. `!hook create <이름> #채널`로 생성하세요.');
        break;
      }
      const lines = Object.entries(hooks).map(([name, h]) =>
        `🔗 **${name}** — <#${h.channelId}> | URL: \`${h.url.slice(0, 40)}...\``
      );
      await message.reply(`**훅 목록:**\n${lines.join('\n')}`);
      break;
    }

    // !hook create <이름> #채널
    case 'create': {
      const hookName = parts[2];
      const channelMention = parts[3];
      const channelId = channelMention?.replace(/[<#>]/g, '');

      if (!hookName || !channelId) {
        await message.reply('사용법: `!hook create <이름> #채널`\n예) `!hook create 알림 #공지사항`');
        break;
      }

      const channel = message.guild.channels.cache.get(channelId);
      if (!channel) { await message.reply('❌ 채널을 찾을 수 없습니다.'); break; }

      const webhook = await channel.createWebhook({
        name: hookName,
        reason: `Claude 봇 훅 생성 by ${message.author.tag}`,
      });

      if (!config.hooks) config.hooks = {};
      config.hooks[hookName] = { url: webhook.url, channelId };
      saveConfig(config);

      await message.reply(
        `✅ **${hookName}** 훅 생성 완료!\n` +
        `채널: <#${channelId}>\n` +
        `URL: \`${webhook.url}\`\n\n` +
        `이 URL로 외부 서비스(GitHub, Jenkins 등)에서 메시지를 보낼 수 있습니다.`
      );
      break;
    }

    // !hook delete <이름>
    case 'delete': {
      const hookName = parts[2];
      if (!config.hooks?.[hookName]) { await message.reply(`❌ \`${hookName}\` 훅이 없습니다.`); break; }
      delete config.hooks[hookName];
      saveConfig(config);
      await message.reply(`✅ **${hookName}** 훅 삭제 완료`);
      break;
    }

    // !hook send <이름> <메시지>
    case 'send': {
      const hookName = parts[2];
      const hookMsg = parts.slice(3).join(' ');
      const hook = config.hooks?.[hookName];

      if (!hook) { await message.reply(`❌ \`${hookName}\` 훅이 없습니다.`); break; }
      if (!hookMsg) { await message.reply('사용법: `!hook send <이름> <메시지>`'); break; }

      const channel = message.guild.channels.cache.get(hook.channelId);
      const webhooks = await channel.fetchWebhooks();
      const wh = webhooks.find(w => w.url === hook.url);
      if (!wh) { await message.reply('❌ 훅을 찾을 수 없습니다. 재생성이 필요합니다.'); break; }

      await wh.send(hookMsg);
      await message.reply(`✅ **${hookName}** 훅으로 메시지 전송 완료`);
      break;
    }

    default:
      await message.reply(
        '**훅 명령어:**\n' +
        '`!hook list` — 훅 목록\n' +
        '`!hook create <이름> #채널` — 웹훅 생성\n' +
        '`!hook delete <이름>` — 훅 삭제\n' +
        '`!hook send <이름> <메시지>` — 훅으로 메시지 전송'
      );
  }
}

// ─────────────────────────────────────────
//  Claude CLI 실행
// ─────────────────────────────────────────

// ── OAuth 인증 상태 관리 ──
let _authFailed = false;           // 현재 인증 실패 상태
let _authFailNotified = false;     // 알림 전송 여부 (중복 알림 방지)
const AUTH_ALERT_CHANNEL = null; // 인증 알림 채널 (하이브마인드)

function isAuthError(output, stderrOutput) {
  const combined = (output + ' ' + stderrOutput).toLowerCase();
  // 정확한 인증 에러 패턴만 매칭 (401은 오탐 방지를 위해 제외)
  return combined.includes('authentication_error')
    || combined.includes('oauth token has expired')
    || combined.includes('invalid_api_key')
    || combined.includes('unauthorized: invalid token')
    || combined.includes('failed to authenticate')
    || (combined.includes('401') && (combined.includes('unauthorized') || combined.includes('auth')));
}

async function notifyAuthFailure() {
  if (_authFailNotified) return;
  _authFailNotified = true;
  try {
    const channel = client.channels.cache.get(AUTH_ALERT_CHANNEL);
    if (channel) {
      await channel.send(
        '🔴 **Claude CLI 인증 만료**\n\n' +
        'OAuth 토큰이 만료되어 봇이 응답할 수 없습니다.\n' +
        '터미널에서 `claude auth login`을 실행하여 재인증해주세요.\n\n' +
        '재인증 후 봇은 자동으로 복구됩니다.'
      );
    }
  } catch (err) {
    console.error('인증 알림 전송 실패:', err.message);
  }
}

// ── OAuth 캐시 무효화 (CLI가 자체 refresh) ──
let _oauthTokenCache = null;
let _oauthTokenExpiry = 0;

function invalidateOAuthCache() {
  _oauthTokenCache = null;
  _oauthTokenExpiry = 0;
}

function _runClaudeOnce(prompt, systemPrompt, agent = {}, sessionId = null, onToolUse = null, onProcSpawn = null) {
  return new Promise((resolve, reject) => {
    const stderrChunks = [];
    let settled = false;

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    // launchctl 서비스에서 PATH가 제한적이므로 보강
    const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', `${process.env.HOME}/.npm-global/bin`, `${process.env.HOME}/.nvm/versions/node`];
    if (cleanEnv.PATH && !cleanEnv.PATH.includes('/usr/local/bin')) {
      cleanEnv.PATH = extraPaths.join(':') + ':' + cleanEnv.PATH;
    }

    // Z.ai Max 구독: Claude CLI를 Z.ai Anthropic 프록시로 우회
    if (agent.backend === 'zai') {
      const zaiKey = process.env.ZAI_API_KEY;
      if (zaiKey) {
        cleanEnv.ANTHROPIC_AUTH_TOKEN = zaiKey;
        cleanEnv.ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
        cleanEnv.API_TIMEOUT_MS = '300000';
        delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
        console.log(`🧿 Z.ai Anthropic 프록시 사용`);
      } else {
        console.log(`⚠️ ZAI_API_KEY 없음 — 기본 Claude로 폴백`);
      }
    } else {
      // Claude 기본: CLI가 자체적으로 키체인에서 읽고 refresh
      delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
    }

    // stream-json 모드: 실시간 도구 사용 이벤트 수신 가능 (--verbose 필수)
    const useStream = !!onToolUse;
    const args = ['-p'];
    if (useStream) {
      args.push('--verbose', '--output-format', 'stream-json');
    } else {
      args.push('--output-format', 'json');
    }

    // 이전 세션 이어가기
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // 허용 도구 설정
    if (agent.allowedTools && agent.allowedTools.length > 0) {
      args.push('--allowedTools', ...agent.allowedTools);
    }

    // 🛡️ 위험 명령 차단 (봇 프로세스 kill 방지)
    // canRestartBot 권한이 있는 에이전트는 프로세스 관리 허용
    const disallowed = [];
    if (!agent.canRestartBot) {
      disallowed.push(
        'Bash(kill:*)', 'Bash(pkill:*)', 'Bash(pgrep:*)',
        'Bash(killall:*)', 'Bash(launchctl:*)'
      );
    }
    disallowed.push('Bash(rm -rf /Volumes:*)', 'Bash(rm -rf ~:*)');

    // 에이전트별 차단 도구 (config.json의 disallowedTools)
    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
      disallowed.push(...agent.disallowedTools);
    }
    args.push('--disallowedTools', ...disallowed);

    // 모델 설정 (에이전트별 모델 지정 가능, 기본: opus)
    const model = agent.model || 'opus';
    args.push('--model', model);

    args.push('--append-system-prompt', systemPrompt, prompt);

    // 작업 디렉토리 설정
    const cwd = agent.workingDir || process.cwd();

    console.log(`🚀 Claude 호출: agent=${agent.name || 'default'} cwd=${cwd} session=${sessionId ? sessionId.slice(0, 8) + '...' : 'new'} format=${useStream ? 'stream' : 'json'}`);
    console.log(`  📋 args: ${args.filter(a => a.startsWith('--')).join(' ')}`);

    const proc = spawn(CLAUDE_BIN, args, {
      env: cleanEnv,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 2시간 타임아웃
    const PROCESS_TIMEOUT = 7200000; // 2시간
    const killTimer = setTimeout(() => {
      if (!settled) {
        console.log('⏰ Claude CLI 타임아웃 (2시간) — 프로세스 강제 종료');
        proc.kill('SIGKILL');
        settled = true;
        reject(new Error('Claude CLI 타임아웃 (2시간 초과)'));
      }
    }, PROCESS_TIMEOUT);

    // 외부에서 프로세스 참조 가능 (중단용)
    if (onProcSpawn) onProcSpawn(proc);

    proc.stderr.on('data', (d) => {
      stderrChunks.push(d.toString());
    });

    if (useStream) {
      // ── stream-json 모드: 실시간 이벤트 파싱 ──
      let buffer = '';
      let resultText = null;
      let resultSessionId = null;
      let resultIsError = false;
      const assistantTexts = [];  // assistant 메시지 텍스트 축적

      proc.stdout.on('data', (d) => {
        buffer += d.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // tool_use 이벤트 감지 (여러 포맷 대응)
            if (event.type === 'tool_use') {
              onToolUse(event.name || event.tool_name || 'unknown', event.input || {});
            } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              onToolUse(event.content_block.name, event.content_block.input || {});
            } else if (event.type === 'assistant') {
              // assistant 메시지 내 텍스트 + tool_use 블록 수집
              const content = event.message?.content || event.content || [];
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_use') {
                    onToolUse(block.name, block.input || {});
                  } else if (block.type === 'text' && block.text) {
                    assistantTexts.push(block.text);
                  }
                }
              }
              // 단일 텍스트 필드
              if (event.message?.text) assistantTexts.push(event.message.text);
              if (typeof event.text === 'string' && event.text) assistantTexts.push(event.text);
            } else if (event.type === 'result') {
              // 최종 결과
              resultText = event.result ?? null;
              resultSessionId = event.session_id || null;
              resultIsError = event.is_error || false;
            }
          } catch {
            // JSON 파싱 실패 — 무시
          }
        }
      });

      proc.on('close', (code) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;

        const stderrOutput = stderrChunks.join('').trim();

        // 최종 텍스트: result 이벤트 우선, 없으면 assistant 텍스트 전부 합침
        const allAssistantText = assistantTexts.length > 0 ? assistantTexts.join('\n\n') : null;
        const finalText = resultText || allAssistantText;

        console.log(`📊 stream 완료: result=${!!resultText} (${resultText ? resultText.length : 0}자) assistantTexts=${assistantTexts.length}개 (${allAssistantText ? allAssistantText.length : 0}자) finalText=${finalText ? finalText.slice(0, 100) + '...' : 'null'}`);

        if (isAuthError(finalText || '', stderrOutput)) {
          const err = new Error('OAuth 토큰 만료');
          err.isAuthError = true;
          reject(err);
          return;
        }

        // thinking signature / invalid_request_error → 세션 깨짐, 새 세션 필요
        if (finalText && (finalText.includes('Invalid `signature` in `thinking`') ||
            finalText.includes('invalid_request_error') ||
            finalText.includes('API Error: 400'))) {
          const err = new Error(finalText.slice(0, 200));
          err.isSessionError = true;
          console.log(`⚠️ 세션 손상 감지 → 새 세션으로 재시도 필요`);
          reject(err);
          return;
        }

        if (_authFailed) {
          _authFailed = false;
          _authFailNotified = false;
          console.log('✅ Claude 인증 복구됨');
        }

        // stream에서 결과를 못 받은 경우 (비정상 종료)
        if (!finalText && code !== 0) {
          let errorMsg = `종료 코드: ${code}`;
          if (stderrOutput) {
            const lastLine = stderrOutput.split('\n').filter(l => l.trim()).pop() || '';
            if (lastLine && !lastLine.includes('DeprecationWarning')) {
              errorMsg += `\n원인: ${lastLine.slice(0, 200)}`;
            }
          }
          reject(new Error(errorMsg));
          return;
        }

        resolve({ text: finalText, sessionId: resultSessionId, isError: resultIsError });
      });

    } else {
      // ── 기존 json 모드 (onToolUse 없을 때) ──
      const chunks = [];

      proc.stdout.on('data', (d) => chunks.push(d.toString()));

      proc.on('close', (code) => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;

        const output = chunks.join('').trim();
        const stderrOutput = stderrChunks.join('').trim();

        if (isAuthError(output, stderrOutput)) {
          const err = new Error('OAuth 토큰 만료');
          err.isAuthError = true;
          reject(err);
          return;
        }

        if (code === 0 || output) {
          if (_authFailed) {
            _authFailed = false;
            _authFailNotified = false;
            console.log('✅ Claude 인증 복구됨');
          }

          try {
            const json = JSON.parse(output);
            const resultText = (json.result != null && json.result !== '') ? json.result : null;
            resolve({
              text: resultText,
              sessionId: json.session_id || null,
              isError: json.is_error || false,
            });
          } catch {
            console.warn('⚠️ JSON 파싱 실패, 원시 텍스트 사용');
            const rawText = output.trim() || null;
            resolve({ text: rawText, sessionId: null, isError: false });
          }
        } else {
          let errorMsg = `종료 코드: ${code}`;
          if (stderrOutput) {
            const lastLine = stderrOutput.split('\n').filter(l => l.trim()).pop() || '';
            if (lastLine && !lastLine.includes('DeprecationWarning')) {
              errorMsg += `\n원인: ${lastLine.slice(0, 200)}`;
            }
          }
          console.error(`❌ Claude 종료: code=${code} stderr=${stderrOutput.slice(0, 300)}`);
          reject(new Error(errorMsg));
        }
      });
    }

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      reject(new Error(`Claude 실행 실패: ${err.message}`));
    });
  });
}

async function runClaude(prompt, systemPrompt, agent = {}, sessionId = null, onToolUse = null, onProcSpawn = null) {
  // ── OpenAI-compatible 백엔드 분기 (deepseek, openai, openrouter) ──
  // ⚠️ Z.ai Max 구독은 OpenAI 엔드포인트 사용 불가 → Claude CLI 프록시로 처리
  // Z.ai는 아래 _runClaudeOnce에서 환경변수 주입으로 Anthropic 프록시 사용
  if (agent.backend && agent.backend !== 'claude' && agent.backend !== 'zai') {
    if (!isBackendAvailable(agent.backend)) {
      throw new Error(`Backend "${agent.backend}" not available. Set ${agent.backend.toUpperCase()}_API_KEY in .env`);
    }
    console.log(`🌐 ${agent.backend} 백엔드 사용: model=${agent.model || 'default'}`);
    const zaiOpts = {
      message: prompt,
      systemPrompt,
      agent,
      backend: agent.backend,
      workingDir: agent.workingDir,
      onToolCall: (name, args) => {
        console.log(`  🔧 [${agent.backend}] ${name}(${JSON.stringify(args).substring(0, 100)})`);
        if (onToolUse) onToolUse(name, args || {});
      },
    };
    let result;
    try {
      result = await runZAI(zaiOpts);
    } catch (err) {
      // 429/rate-limit → 키 로테이션 후 1회 재시도
      if (err.message?.includes('429') || err.message?.includes('rate limit')) {
        rotateZhipuKey();
        const newKey = getZhipuApiKey();
        if (newKey) process.env.ZAI_API_KEY = newKey;
        console.log('🔄 ZhiPu 키 로테이션 후 재시도...');
        result = await runZAI(zaiOpts);
      } else {
        throw err;
      }
    }
    console.log(`  📊 [${agent.backend}] tokens: ${result.usage.prompt_tokens}+${result.usage.completion_tokens}, tools: ${result.toolCalls.length}`);
    return result;
  }

  // ── Claude CLI 경로 (기본) ──
  // 이미 인증 실패 상태 → 키체인에서 새 토큰 시도
  if (_authFailed) {
    console.log('⚠️ 인증 실패 상태 — 키체인 토큰 재확인 중...');
    invalidateOAuthCache();
    try {
      const result = await _runClaudeOnce(prompt, systemPrompt, agent, sessionId, onToolUse, onProcSpawn);
      _authFailed = false;
      _authFailNotified = false;
      console.log('✅ 인증 자동 복구됨!');
      return result;
    } catch (e) {
      if (e.isAuthError) {
        throw new Error('🔴 Claude 인증이 만료되었습니다. 터미널에서 `claude auth login`을 실행해주세요.');
      }
      throw e; // 인증 외 에러는 그대로 전파
    }
  }

  try {
    return await _runClaudeOnce(prompt, systemPrompt, agent, sessionId, onToolUse, onProcSpawn);
  } catch (err) {
    if (!err.isAuthError) throw err;

    // 인증 오류 → OAuth 캐시 무효화 후 5초 후 1회 재시도
    console.warn('⚠️ 인증 오류 감지, OAuth 캐시 무효화 후 5초 후 재시도...');
    invalidateOAuthCache();
    await new Promise(r => setTimeout(r, 5000));

    try {
      const result = await _runClaudeOnce(prompt, systemPrompt, agent, sessionId, onToolUse, onProcSpawn);
      console.log('✅ 재시도 성공 — 인증 자동 갱신됨');
      return result;
    } catch (retryErr) {
      if (retryErr.isAuthError) {
        // 재시도도 실패 → 인증 완전 만료
        _authFailed = true;
        console.error('🔴 인증 재시도 실패 — OAuth 토큰 완전 만료');
        await notifyAuthFailure();
        throw new Error('🔴 Claude 인증이 만료되었습니다. 터미널에서 `claude auth login`을 실행해주세요.');
      }
      throw retryErr;
    }
  }
}

// ── 주기적 인증 상태 체크 (30분마다) ──
setInterval(async () => {
  try {
    const { execSync } = require('child_process');
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;  // CLI가 자체 refresh하도록
    const status = execSync(`${CLAUDE_BIN} auth status`, { env, timeout: 10000 }).toString();
    const parsed = JSON.parse(status);
    if (!parsed.loggedIn) {
      if (!_authFailed) {
        _authFailed = true;
        console.warn('⚠️ 주기적 체크: Claude 인증 만료 감지');
        await notifyAuthFailure();
      }
    } else if (_authFailed) {
      _authFailed = false;
      _authFailNotified = false;
      console.log('✅ 주기적 체크: Claude 인증 복구 확인');
      try {
        const channel = client.channels.cache.get(AUTH_ALERT_CHANNEL);
        if (channel) await channel.send('🟢 **Claude 인증 복구됨** — 정상 동작합니다.');
      } catch {}
    }
  } catch (err) {
    console.warn('⚠️ 인증 상태 체크 실패:', err.message);
  }
}, 30 * 60 * 1000);

// JSON 파싱 시도
function tryParseJSON(raw) {
  // 1차: 전체가 JSON인 경우
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.message || parsed.actions || parsed.delegate) return { parsed, before: '', after: '' };
    return null;
  } catch {}

  // 2차: 텍스트 안에 JSON이 섞여있는 경우 → { 로 시작하는 부분 찾기
  // 문자열 내부의 중괄호를 무시하고 정확한 JSON 경계를 찾음
  let searchFrom = 0;
  while (searchFrom < raw.length) {
    const jsonStart = raw.indexOf('{"', searchFrom);
    if (jsonStart === -1) break;

    // JSON 끝 찾기: 문자열 내부의 {}를 무시
    let depth = 0;
    let jsonEnd = -1;
    let inString = false;
    let escape = false;

    for (let i = jsonStart; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    }

    if (jsonEnd === -1) break;

    try {
      const jsonStr = raw.slice(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonStr);
      if (parsed.message || parsed.actions || parsed.delegate || parsed.delegates) {
        const before = raw.slice(0, jsonStart).trim();
        const after = raw.slice(jsonEnd).trim();
        return { parsed, before, after };
      }
    } catch {}

    searchFrom = jsonStart + 1;  // 이 위치에서 실패하면 다음 { 찾기
  }

  return null;
}

// ─────────────────────────────────────────
//  Discord 액션 실행
// ─────────────────────────────────────────
async function executeActions(message, actions) {
  const guild = message.guild;
  const results = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'createChannel': {
          const typeMap = {
            text: ChannelType.GuildText,
            voice: ChannelType.GuildVoice,
            category: ChannelType.GuildCategory,
          };
          await guild.channels.create({ name: action.name, type: typeMap[action.channelType] || ChannelType.GuildText });
          results.push(`✅ #${action.name} 채널 생성 완료`);
          break;
        }
        case 'deleteChannel': {
          const ch = guild.channels.cache.find(c => c.name === action.name);
          if (!ch) { results.push(`❌ "${action.name}" 채널 없음`); break; }
          await ch.delete();
          results.push(`✅ #${action.name} 채널 삭제 완료`);
          break;
        }
        case 'renameChannel': {
          const ch = guild.channels.cache.find(c => c.name === action.name);
          if (!ch) { results.push(`❌ "${action.name}" 채널 없음`); break; }
          await ch.setName(action.newName);
          results.push(`✅ ${action.name} → ${action.newName} 변경 완료`);
          break;
        }
        case 'createRole': {
          await guild.roles.create({ name: action.name, color: action.color || '#99AAB5' });
          results.push(`✅ "${action.name}" 역할 생성 완료`);
          break;
        }
        case 'deleteRole': {
          const role = guild.roles.cache.find(r => r.name === action.name);
          if (!role) { results.push(`❌ "${action.name}" 역할 없음`); break; }
          await role.delete();
          results.push(`✅ "${action.name}" 역할 삭제 완료`);
          break;
        }
        case 'sendMessage': {
          const ch = guild.channels.cache.find(c => c.name === action.channel);
          if (!ch) { results.push(`❌ "${action.channel}" 채널 없음`); break; }
          await ch.send(action.content);
          results.push(`✅ #${action.channel} 메시지 전송 완료`);
          break;
        }
        default:
          results.push(`⚠️ 알 수 없는 액션: ${action.type}`);
      }
    } catch (err) {
      results.push(`❌ ${action.type} 실패: ${err.message}`);
    }
  }

  if (results.length > 0) await message.channel.send(results.join('\n'));
}

// ─────────────────────────────────────────
//  응답 전송 (파일 감지 + 길이 분할)
// ─────────────────────────────────────────
async function sendResponseWithFiles(message, response) {
  if (!response?.trim()) return;

  // [[FILE:경로]] 패턴 감지
  const filePattern = /\[\[FILE:(.*?)\]\]/g;
  const filePaths = [];
  let match;
  while ((match = filePattern.exec(response)) !== null) {
    filePaths.push(match[1].trim());
  }

  // 파일 패턴 제거한 텍스트
  const cleanText = response.replace(filePattern, '').trim();

  // 텍스트 전송
  if (cleanText) {
    await sendResponse(message, cleanText);
  }

  // 파일 전송
  if (filePaths.length > 0) {
    const validFiles = filePaths.filter(p => {
      if (!fs.existsSync(p)) { console.warn(`파일 없음: ${p}`); return false; }
      return true;
    });

    const discordFiles = [];  // Discord로 보낼 파일 (10MB 이하)
    const telegramFiles = []; // Telegram으로 보낼 파일 (10MB 초과)

    for (const p of validFiles) {
      const size = fs.statSync(p).size;
      if (size > DISCORD_FILE_LIMIT) {
        telegramFiles.push(p);
      } else {
        discordFiles.push({ attachment: p, name: path.basename(p) });
      }
    }

    // Discord 파일 전송
    if (discordFiles.length > 0) {
      try {
        await message.channel.send({ files: discordFiles });
        console.log(`📤 Discord 파일 전송: ${discordFiles.map(f => f.name).join(', ')}`);
      } catch (err) {
        console.error('Discord 파일 전송 실패:', err.message);
        // Discord 실패 시 텔레그램으로 대체
        telegramFiles.push(...discordFiles.map(f => f.attachment));
      }
    }

    // 대용량 파일 → Telegram 전송
    if (telegramFiles.length > 0) {
      const telegramResults = await sendFilesViaTelegram(telegramFiles);
      if (telegramResults.success > 0) {
        await message.channel.send(`📨 대용량 파일 ${telegramResults.success}개를 Telegram으로 전송했습니다. 파일 수신 채널을 확인하세요.`);
      }
      if (telegramResults.failed > 0) {
        await message.channel.send(`❌ ${telegramResults.failed}개 파일 전송 실패`);
      }
    }
  }
}

// Telegram API로 대용량 파일 전송 (Discord 10MB 제한 우회)
async function sendFilesViaTelegram(filePaths) {
  const config = loadConfig();
  const telegramToken = process.env.TELEGRAM_TOKEN;
  const telegramChatId = config.telegramFileChatId; // config에 설정 필요

  if (!telegramToken || !telegramChatId) {
    console.warn('⚠️ Telegram 파일 전송 미설정: TELEGRAM_TOKEN 또는 telegramFileChatId 없음');
    return { success: 0, failed: filePaths.length };
  }

  let success = 0, failed = 0;

  for (const filePath of filePaths) {
    try {
      const FormData = require('form-data') || null;
      // node 내장 모듈로 multipart 전송
      const fileName = path.basename(filePath);
      const fileSize = fs.statSync(filePath).size;
      const sizeMB = (fileSize / 1024 / 1024).toFixed(1);

      // Telegram sendDocument API (50MB까지 지원)
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const fileData = fs.readFileSync(filePath);

      const header = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${telegramChatId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n📤 ${fileName} (${sizeMB}MB) — Discord에서 전송됨\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      const footer = `\r\n--${boundary}--\r\n`;

      const body = Buffer.concat([Buffer.from(header), fileData, Buffer.from(footer)]);

      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${telegramToken}/sendDocument`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            const result = JSON.parse(data);
            if (result.ok) { success++; resolve(); }
            else { failed++; console.error(`Telegram 전송 실패: ${result.description}`); reject(new Error(result.description)); }
          });
        });
        req.on('error', (e) => { failed++; reject(e); });
        req.write(body);
        req.end();
      });
      console.log(`📨 Telegram 파일 전송: ${fileName} (${sizeMB}MB)`);
    } catch (err) {
      console.error(`❌ Telegram 파일 전송 실패 [${path.basename(filePath)}]:`, err.message);
      failed++;
    }
  }

  return { success, failed };
}

async function sendResponse(message, response) {
  if (!response?.trim()) return;
  if (response.length <= MAX_RESPONSE_LENGTH) { await message.reply(response); return; }
  const parts = splitMessage(response);
  for (let i = 0; i < parts.length; i++) {
    const content = parts.length > 1 ? `**[${i + 1}/${parts.length}]**\n${parts[i]}` : parts[i];
    if (i === 0) await message.reply(content);
    else await message.channel.send(content);
  }
}

function splitMessage(text) {
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_RESPONSE_LENGTH) { parts.push(remaining); break; }
    let idx = remaining.lastIndexOf('\n', MAX_RESPONSE_LENGTH);
    if (idx === -1 || idx < MAX_RESPONSE_LENGTH / 2) idx = remaining.lastIndexOf(' ', MAX_RESPONSE_LENGTH);
    if (idx === -1 || idx < MAX_RESPONSE_LENGTH / 2) idx = MAX_RESPONSE_LENGTH;
    parts.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return parts;
}

// ─────────────────────────────────────────
//  tmp 파일 정리 (1시간마다)
// ─────────────────────────────────────────
setInterval(() => {
  try {
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TMP_DIR, file);
      const stats = fs.statSync(filePath);
      // 1시간 이상 된 파일 삭제
      if (now - stats.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ tmp 정리: ${file}`);
      }
    }
  } catch (err) {
    // 무시
  }
}, 3600000);

// ── 만료된 대화 세션 정리 (SESSION_TTL=0이면 비활성화) ─────────
if (SESSION_TTL > 0) {
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [channelId, session] of channelSessions) {
      if (now - session.lastUsed > SESSION_TTL) {
        channelSessions.delete(channelId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 만료 세션 ${cleaned}개 정리 (활성: ${channelSessions.size}개)`);
    }
  }, 10 * 60 * 1000);
}

// ─────────────────────────────────────────
//  📊 프로젝트별 실시간 대시보드 시스템
// ─────────────────────────────────────────
// config.json에 projects 필드로 프로젝트별 에이전트 그룹핑:
// "projects": {
//   "overmind": { "name": "Project Overmind", "emoji": "🧠", "agents": ["overmind","router",...] },
//   "commandcenter": { "name": "Command Center", "emoji": "🎬", "agents": ["cc_video",...] }
// }
// projects가 없으면 전체 에이전트를 하나의 대시보드로 표시

const dashboards = new Map();  // projectId → { channel, message, lastState }
let dashboardTick = 0;         // 애니메이션 틱 (5초마다 증가)
// dashTickCount는 dashboardTick으로 통합됨

async function setupDashboard() {
  try {
    const config = loadConfig();
    // guildId가 config에 없으면 봇이 참여한 첫 번째 길드 사용
    const guildId = config.guildId || client.guilds.cache.first()?.id;
    if (!guildId) { console.log('📊 대시보드: 참여한 서버 없음'); return; }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) { console.log('📊 대시보드: 서버를 찾을 수 없음'); return; }

    // 프로젝트 정의 (없으면 서버 이름으로 기본 대시보드 1개)
    let projects = config.projects;
    if (!projects || Object.keys(projects).length === 0) {
      const allAgents = Object.keys(config.agents || {}).filter(id => id !== 'default');
      projects = {
        _default: { name: guild.name || '대시보드', emoji: '📊', agents: allAgents }
      };
    }

    for (const [projId, proj] of Object.entries(projects)) {
      const channelName = projId === '_default'
        ? '📊-대시보드'
        : `📊-${proj.name.toLowerCase().replace(/\s+/g, '-')}`;

      // 채널 찾기: 1) config의 dashboardChannelId → 2) 이름 매칭 → 3) 새로 생성
      let channel = null;

      // 1차: dashboardChannelId로 직접 찾기 (가장 확실)
      if (proj.dashboardChannelId) {
        channel = guild.channels.cache.get(proj.dashboardChannelId) || null;
        if (channel) {
          console.log(`📊 [${proj.name}] dashboardChannelId로 채널 찾음: #${channel.name}`);
        }
      }

      // 2차: 이름 매칭 (정확한 이름 + 키워드 포함 매칭)
      if (!channel) {
        const projKeyword = proj.name.toLowerCase().replace(/\s+/g, '-');
        channel = guild.channels.cache.find(
          ch => ch.type === ChannelType.GuildText && (
            ch.name === channelName ||
            (ch.name.includes('대시보드') && ch.name.includes(projKeyword.split('-')[0]))
          )
        ) || null;
      }

      // 3차: 없으면 새로 생성
      if (!channel) {
        channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: `${proj.emoji} ${proj.name} 에이전트 실시간 대시보드`,
          reason: 'Claude Bot 대시보드 자동 생성',
        });
        console.log(`📊 대시보드 채널 생성: #${channelName}`);

        // 생성된 채널 ID를 config에 자동 저장 (다음 재시작 시 ID로 찾기)
        try {
          const freshConfig = loadConfig();
          if (freshConfig.projects && freshConfig.projects[projId]) {
            freshConfig.projects[projId].dashboardChannelId = channel.id;
            const configPath = require('path').join(__dirname, 'config.json');
            require('fs').writeFileSync(configPath, JSON.stringify(freshConfig, null, 2), 'utf-8');
            console.log(`📊 [${proj.name}] dashboardChannelId 자동 저장: ${channel.id}`);
          }
        } catch (saveErr) {
          console.warn(`📊 dashboardChannelId 저장 실패:`, saveErr.message);
        }
      }

      // 기존 봇 대시보드 메시지 찾기 (핀 우선 → 최근 메시지 fallback)
      let botMsg = null;

      // 1차: 핀된 메시지에서 찾기 (가장 확실)
      try {
        const pinned = await channel.messages.fetchPinned();
        botMsg = pinned.find(m => m.author.id === client.user.id && m.embeds.length > 0);
      } catch {}

      // 2차: 최근 메시지에서 찾기
      if (!botMsg) {
        const messages = await channel.messages.fetch({ limit: 20 });
        botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
      }

      let message;
      if (botMsg) {
        message = botMsg;
        console.log(`📊 [${proj.name}] 기존 대시보드 재사용 (id=${message.id})`);
      } else {
        const embed = buildProjectEmbed(projId, proj, config);
        message = await channel.send({ embeds: [embed] });
        try { await message.pin(); } catch {}
        console.log(`📊 [${proj.name}] 대시보드 생성 및 고정`);
      }

      dashboards.set(projId, { channel, message, lastState: '', project: proj });
    }

    // 대시보드 채널 메시지 삭제는 메인 messageCreate 핸들러에서 처리

    // 5초마다 전체 업데이트 (중복 등록 방지)
    if (!setupDashboard._intervalRegistered) {
      setupDashboard._intervalRegistered = true;
      setInterval(() => updateAllDashboards(), 5000);
    }
    console.log(`📊 대시보드 ${dashboards.size}개 활성화 (5초 간격)`);
  } catch (err) {
    console.error('❌ 대시보드 설정 실패:', err.message);
  }
}

function buildProjectEmbed(projId, proj, config) {
  const agents = config.agents || {};
  const bindings = config.channelBindings || {};

  // 바인딩 역맵
  const agentChannelMap = {};
  for (const [chId, agId] of Object.entries(bindings)) {
    if (!agentChannelMap[agId]) agentChannelMap[agId] = [];
    agentChannelMap[agId].push(chId);
  }

  // 이 프로젝트의 에이전트 목록
  const projAgents = proj.agents || Object.keys(agents).filter(id => id !== 'default');

  let activeCount = 0;
  let idleCount = 0;

  // 1단계: 이름 최대 길이 계산 (한글은 2칸, 영문/숫자는 1칸)
  function displayWidth(str) {
    let w = 0;
    for (const ch of str) {
      w += /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 2 : 1;
    }
    return w;
  }
  function padToWidth(str, targetWidth) {
    const diff = targetWidth - displayWidth(str);
    return diff > 0 ? str + ' '.repeat(diff) : str;
  }

  const agentData = [];
  let maxWidth = 0;

  for (const agentId of projAgents) {
    const agent = agents[agentId];
    if (!agent) continue;
    const name = agent.name || agentId;
    const w = displayWidth(name);
    if (w > maxWidth) maxWidth = w;

    const boundChannels = agentChannelMap[agentId] || [];
    let isWorking = false;
    let toolInfo = '';
    let queueCount = 0;

    for (const chId of boundChannels) {
      if (activeRequests.has(chId)) {
        isWorking = true;
        // taskId 기반 activeProcesses에서 이 채널의 작업 찾기
        for (const [tId, proc] of activeProcesses) {
          if (proc.channelId === chId && proc.currentTool) {
            toolInfo = proc.currentTool;
            break;
          }
        }
      }
      const q = messageQueues.get(chId);
      if (q) queueCount += q.length;
    }

    // 위임 작업 감지 (delegateKey 또는 agentId 필드로 감지)
    if (!isWorking) {
      for (const [key, proc] of activeProcesses) {
        if (key.startsWith(`delegate_${agentId}_`) || proc.agentId === agentId) {
          isWorking = true;
          if (proc.currentTool) toolInfo = proc.currentTool;
          break;
        }
      }
    }

    // 이 에이전트의 동시 작업 수 계산
    let concurrentCount = 0;
    for (const chId of boundChannels) {
      concurrentCount += getTaskCount(chId);
    }

    if (isWorking) activeCount++;
    else idleCount++;

    agentData.push({ name, avatar: agent.avatar || '🤖', isWorking, toolInfo, queueCount, concurrentCount });
  }

  // 2단계: 유니코드 공백으로 열 정렬 (코드블록 없이)
  const THIN = '\u2005';  // four-per-em space
  const lines = agentData.map(a => {
    const dot = a.isWorking ? '🟢' : '⚪';
    const nameW = displayWidth(a.name);
    const gap = maxWidth - nameW;
    const padding = THIN.repeat(gap * 2 + 2);
    // 작업중 애니메이션: 작업중. → 작업중.. → 작업중...
    const dots = '.'.repeat((dashboardTick % 3) + 1);
    let status;
    if (a.isWorking) {
      if (a.toolInfo) {
        // 도구 정보 요약: 경로 → 파일명만, 긴 텍스트 → 축약
        let info = a.toolInfo;
        // 파일 경로가 있으면 파일명만 추출
        info = info.replace(/\/[^\s]*\/([^\/\s]+)/g, '$1');
        // 그래도 길면 자르기
        if (info.length > 20) info = info.slice(0, 18) + '..';
        status = info;
      } else {
        status = `작업중${dots}`;
      }
    } else {
      status = '대기중';
    }
    if (a.concurrentCount > 1) status += ` ⚡×${a.concurrentCount}`;
    if (a.queueCount > 0) status += ` 📥+${a.queueCount}`;
    return `${dot} ${a.avatar} **${a.name}**${padding}${status}`;
  });

  // 3단계: 오늘(0시~지금) + 어제 통계
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

  const todayTasks = taskHistory.filter(t => t.timestamp >= todayStart.getTime());
  const yesterdayTasks = taskHistory.filter(t => t.timestamp >= yesterdayStart.getTime() && t.timestamp < todayStart.getTime());

  const todayCount = todayTasks.length;
  const todayAvgMs = todayCount > 0 ? todayTasks.reduce((s, t) => s + t.durationMs, 0) / todayCount : 0;
  const yesterdayCount = yesterdayTasks.length;
  const yesterdayAvgMs = yesterdayCount > 0 ? yesterdayTasks.reduce((s, t) => s + t.durationMs, 0) / yesterdayCount : 0;

  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // 이모지 헤더 + 코드블록 본문
  const header = `${proj.emoji} **${proj.name}**`;
  const agentList = lines.join('\n');
  const todayTotalMs = todayTasks.reduce((s, t) => s + t.durationMs, 0);
  const yesterdayTotalMs = yesterdayTasks.reduce((s, t) => s + t.durationMs, 0);

  const line1 = `🟢 가동 **${activeCount}**  ⚪ 대기 **${idleCount}**`;
  const line2 = `✅ 오늘 **${todayCount}**건  ⏱ **${todayTotalMs > 0 ? formatUptime(todayTotalMs) : '-'}**`;
  const line3 = `📋 어제 **${yesterdayCount}**건  ⏱ **${yesterdayTotalMs > 0 ? formatUptime(yesterdayTotalMs) : '-'}**`;
  const stats = `${line1}\n${line2}\n${line3}`;

  return {
    description: `${header}\n\n${agentList}\n\n${stats}`,
    color: 0x2b2d31,
    footer: { text: `마지막 업데이트 ${timeStr}` },
  };
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

async function updateAllDashboards() {
  dashboardTick++;
  const hasActiveWork = activeRequests.size > 0;
  const config = loadConfig();
  const guild = client.guilds.cache.first();
  let projects = config.projects;
  if (!projects || Object.keys(projects).length === 0) {
    const allAgents = Object.keys(config.agents || {}).filter(id => id !== 'default');
    projects = {
      _default: { name: guild?.name || '대시보드', emoji: '📊', agents: allAgents }
    };
  }

  for (const [projId, dash] of dashboards) {
    const proj = projects[projId] || dash.project;
    try {
      const embed = buildProjectEmbed(projId, proj, config);
      const stateKey = embed.description;
      // 작업중이면 애니메이션을 위해 항상 업데이트, 아니면 변경 시만
      if (!hasActiveWork && stateKey === dash.lastState) continue;
      dash.lastState = stateKey;

      await dash.message.edit({ embeds: [embed] });
    } catch (err) {
      if (err.code === 10008) {
        // 메시지 삭제됨 → 재생성
        try {
          const embed = buildProjectEmbed(projId, proj, config);
          const newMsg = await dash.channel.send({ embeds: [embed] });
          try { await newMsg.pin(); } catch {}
          dash.message = newMsg;
          console.log(`📊 [${proj.name}] 대시보드 재생성`);
        } catch {}
      }
    }
  }
}

async function updateDashboard() {
  // 즉시 갱신 (상태 변경 시 호출)
  updateAllDashboards();
}

// ─────────────────────────────────────────
//  📋 CHANGELOG (자동 업데이트 시 표시)
// ─────────────────────────────────────────
/*CHANGELOG_START
## v3.0.1
- 🧿 !zai 원클릭 Z.ai 에이전트 생성 (채널+바인딩 자동)
- 🔧 세션 손상 자동 감지 및 복구 (thinking signature 에러)
- 🤝 병렬 다중 에이전트 위임 (delegates 배열)
- 🛡️ 프로세스 보호 (disallowedTools로 kill/pkill 차단)
- 📊 프로젝트별 실시간 대시보드
- 🔄 자동 업데이트 시스템 (매일 오전 9시 체크)
- 🧿 Z.ai 기본 모델: GLM-5

## v2.9.12
- 🔄 자동 업데이트 시스템 구축
- 🤝 에이전트 위임 시 답변 즉시 전송 후 종료
- 📝 세션 자동 요약 + 리셋 (100턴)
- 💬 간단한 대화에 도구 사용 방지
CHANGELOG_END*/

// ─────────────────────────────────────────
//  🔄 자동 업데이트 시스템
// ─────────────────────────────────────────
// config.json에 updateUrl 설정 시 매일 체크:
// "updateUrl": "https://raw.githubusercontent.com/user/repo/main/bot.js"
// 또는 로컬 서버: "updateUrl": "http://192.168.x.x:8080/bot.js"

const UPDATE_CHECK_FILE = path.join(__dirname, '.update-check');
const BOT_VERSION = '3.0.3';

async function checkForUpdates() {
  const config = loadConfig();
  const updateUrl = config.updateUrl || 'https://raw.githubusercontent.com/projovermind/claude-discord-bot/main/bot-release.js';

  // 하루에 한번만 체크
  try {
    if (fs.existsSync(UPDATE_CHECK_FILE)) {
      const lastCheck = parseInt(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8').trim(), 10);
      if (Date.now() - lastCheck < 24 * 60 * 60 * 1000) return;
    }
  } catch {}

  console.log(`🔄 업데이트 확인 중... (${updateUrl})`);

  try {
    const remoteCode = await fetchUrl(updateUrl);
    if (!remoteCode || remoteCode.length < 1000) {
      console.log('⚠️ 업데이트 파일을 가져올 수 없습니다.');
      return;
    }

    // 버전 비교
    const versionMatch = remoteCode.match(/const BOT_VERSION\s*=\s*'([^']+)'/);
    const remoteVersion = versionMatch ? versionMatch[1] : 'unknown';

    if (remoteVersion === BOT_VERSION) {
      console.log(`✅ 최신 버전입니다 (v${BOT_VERSION})`);
      fs.writeFileSync(UPDATE_CHECK_FILE, Date.now().toString());
      return;
    }

    console.log(`📦 새 버전 발견: v${remoteVersion} (현재: v${BOT_VERSION})`);

    // 업데이트 파일 임시 저장
    const updatePath = path.join(__dirname, '.bot-update.js');
    fs.writeFileSync(updatePath, remoteCode);

    // 하이브마인드 또는 첫 번째 채널에 승인 요청
    const guild = client.guilds.cache.first();
    if (!guild) return;

    const notifyChannel = guild.channels.cache.find(
      ch => ch.name.includes('하이브마인드') || ch.name.includes('hivemind')
    ) || guild.channels.cache.find(ch => ch.type === ChannelType.GuildText);

    if (notifyChannel) {
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('update_approve')
          .setLabel(`✅ v${remoteVersion} 업데이트`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('update_reject')
          .setLabel('❌ 나중에')
          .setStyle(ButtonStyle.Secondary),
      );

      // 변경사항 추출 (CHANGELOG 블록에서 최근 2개 버전)
      let changelog = '';
      const clBlock = remoteCode.match(/\/\*CHANGELOG_START\n([\s\S]*?)CHANGELOG_END\*\//);
      if (clBlock) {
        const sections = clBlock[1].split(/^## /m).filter(s => s.trim());
        // 최근 2개 섹션만 표시
        const recentSections = sections.slice(0, 2).map(sec => {
          const lines = sec.trim().split('\n');
          const verTitle = lines[0].trim();
          const items = lines.slice(1).map(l => l.trim()).filter(l => l.startsWith('-'));
          return items.length > 0 ? `**v${verTitle}**\n${items.join('\n')}` : null;
        }).filter(Boolean);
        changelog = recentSections.length > 0 ? recentSections.join('\n\n') : '변경 내역 없음';
      } else {
        changelog = '변경 내역 없음';
      }

      await notifyChannel.send({
        embeds: [{
          color: 0x3B82F6,
          author: { name: '🔄 새 업데이트 발견' },
          description: `**v${BOT_VERSION}** → **v${remoteVersion}**\n\n${changelog}`,
          footer: { text: '승인 후 자동으로 업데이트 및 재시작됩니다.' },
        }],
        components: [row],
      });
    }

    fs.writeFileSync(UPDATE_CHECK_FILE, Date.now().toString());
  } catch (err) {
    console.error('❌ 업데이트 확인 실패:', err.message);
  }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// 업데이트 승인 버튼 핸들러
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'update_approve') {
    const updatePath = path.join(__dirname, '.bot-update.js');
    if (!fs.existsSync(updatePath)) {
      await interaction.reply({ content: '❌ 업데이트 파일을 찾을 수 없습니다.', ephemeral: true });
      return;
    }

    await interaction.reply({ content: '🔄 업데이트 적용 중... 잠시 후 봇이 재시작됩니다.' });

    // 백업 → 교체 → 재시작
    const botPath = path.join(__dirname, 'bot.js');
    const backupPath = path.join(__dirname, '.bot-backup.js');
    try {
      fs.copyFileSync(botPath, backupPath);
      fs.copyFileSync(updatePath, botPath);
      fs.unlinkSync(updatePath);
      console.log('✅ 업데이트 적용 완료, 재시작 중...');

      // 세션 저장 후 프로세스 종료 (LaunchAgent가 KeepAlive로 재시작)
      saveSessions();
      process.exit(0);
    } catch (err) {
      // 롤백
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, botPath);
      }
      await interaction.followUp({ content: `❌ 업데이트 실패: ${err.message}\n이전 버전으로 롤백했습니다.` });
    }
  }

  if (interaction.customId === 'update_reject') {
    const updatePath = path.join(__dirname, '.bot-update.js');
    try { fs.unlinkSync(updatePath); } catch {}
    await interaction.reply({ content: '⏭ 업데이트를 건너뛰었습니다. 내일 다시 확인합니다.', ephemeral: true });
  }
});

// ─────────────────────────────────────────
//  🤝 에이전트 간 협업 시스템
// ─────────────────────────────────────────
// 에이전트가 다른 에이전트에게 작업을 위임할 수 있음
// 응답에 {"delegate": {"agent": "에이전트ID", "task": "작업 내용"}} 포함 시 자동 실행

async function delegateToAgent(sourceAgent, targetAgentId, task, originalMessage) {
  const config = loadConfig();
  const targetAgent = config.agents?.[targetAgentId];

  if (!targetAgent) {
    console.log(`⚠️ 위임 실패: 에이전트 '${targetAgentId}' 없음`);
    return null;
  }

  const agentLabel = `${targetAgent.avatar || '🤖'} ${targetAgent.name}`;
  console.log(`🤝 [${sourceAgent}] → [${targetAgent.name}] 위임: ${task.slice(0, 50)}...`);

  // 위임받은 에이전트의 바인딩 채널 찾기
  const bindings = config.channelBindings || {};
  let targetChannelId = null;
  for (const [chId, agId] of Object.entries(bindings)) {
    if (agId === targetAgentId) { targetChannelId = chId; break; }
  }

  const guild = originalMessage.guild;
  const targetChannel = targetChannelId ? guild.channels.cache.get(targetChannelId) : null;
  const workChannel = targetChannel || originalMessage.channel;

  // 위임 대상 채널 동시 작업 수 확인
  if (targetChannelId) {
    const currentTasks = getTaskCount(targetChannelId);
    if (currentTasks >= MAX_CONCURRENT_PER_CHANNEL) {
      console.log(`⚠️ 위임 대상 채널 ${targetChannelId} 작업 중 — 큐에 추가`);
      const queue = getQueue(targetChannelId);
      queue.push({ message: originalMessage, prompt: task });
      return;
    }
  }

  // 대시보드에 위임 에이전트 표시
  const delegateKey = `delegate_${targetAgentId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const delegateChannelId = targetChannelId || delegateKey;
  if (targetChannelId) incrementTaskCount(targetChannelId);
  else activeRequests.add(delegateKey);  // 채널 없는 위임은 기존 방식
  activeProcesses.set(delegateKey, {
    proc: null,
    agentLabel,
    currentTool: '🤝 요청 분석 중...',
    agentId: targetAgentId,
    channelId: targetChannelId || delegateKey,
  });
  updateDashboard();

  const startTime = Date.now();
  const toolSteps = [];
  const TOOL_ICONS_D = {
    Read: '📖', Write: '📝', Edit: '✏️', Bash: '💻',
    Grep: '🔎', Glob: '📂', Agent: '🤖', WebSearch: '🌐',
  };

  // 위임 에이전트 모델 라벨
  const _delegateModelLabel = getModelDisplayLabel(targetAgent.model || 'opus') || 'Claude Opus';

  // 위임받은 채널에 진행 임베드 표시
  let progressMsg = null;
  try {
    progressMsg = await workChannel.send({
      embeds: [{
        color: 0x8B5CF6,
        author: { name: `${agentLabel} 작업 중...` },
        description: `🤝 **${sourceAgent}**로부터 위임받은 작업\n🔍 분석 중... (도구 0회 사용)\n\n\`${task.slice(0, 150)}\``,
        footer: { text: `⏱️ 0초 경과 | 🧠 ${_delegateModelLabel}` },
      }],
    });
  } catch {}

  // 진행 메시지 업데이트 타이머
  let lastEditTime = 0;
  const progressInterval = setInterval(async () => {
    if (!progressMsg) return;
    const now = Date.now();
    if (now - lastEditTime < 2500) return;
    lastEditTime = now;

    const elapsed = Math.round((now - startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const timeStr = min > 0 ? `${min}분 ${sec}초` : `${sec}초`;

    // 최근 5개 도구만 표시
    const recent = toolSteps.slice(-5);
    const toolLines = recent.map(s => `└─ ${s.icon} ${s.tool}${s.detail ? ': ' + s.detail : ''}`).join('\n');
    const older = toolSteps.length > 5 ? `... +${toolSteps.length - 5}개 이전 작업\n` : '';

    try {
      await progressMsg.edit({
        embeds: [{
          color: 0x8B5CF6,
          author: { name: `${agentLabel} 작업 중...` },
          description: `🔧 작업 진행 중... (도구 ${toolSteps.length}회 사용)\n\n\`\`\`\n${older}${toolLines || '분석 중...'}\n\`\`\``,
          footer: { text: `⏱️ ${timeStr} 경과 | 🧠 ${_delegateModelLabel}` },
        }],
      });
    } catch {}
  }, 3000);

  const delegateConfig = loadConfig();
  const systemPrompt = buildSystemPrompt(targetAgent, targetAgentId, delegateConfig, null);

  try {
    const onToolUse = (toolName, input) => {
      const icon = TOOL_ICONS_D[toolName] || '⚙️';
      let detail = '';
      if (input?.file_path) detail = input.file_path.split('/').slice(-2).join('/');
      else if (input?.command) detail = input.command.length > 40 ? input.command.slice(0, 37) + '...' : input.command;
      else if (input?.pattern) detail = `"${input.pattern}"`;

      toolSteps.push({ icon, tool: toolName, detail });

      const proc = activeProcesses.get(delegateKey);
      if (proc) proc.currentTool = `${icon} ${toolName}${detail ? ': ' + detail.slice(0, 25) : ''}`;
    };

    const onProcSpawn = (proc) => {
      const entry = activeProcesses.get(delegateKey);
      if (entry) entry.proc = proc;
    };

    // 타이핑 표시
    workChannel.sendTyping().catch(() => {});
    const typingInterval = setInterval(() => {
      workChannel.sendTyping().catch(() => {});
    }, 5000);

    // 위임받은 에이전트의 기존 세션 이어가기 (컨텍스트 유지)
    const delegateSessionId = targetChannelId ? getSessionId(targetChannelId) : null;
    let result;
    try {
      result = await _runClaudeOnce(task, systemPrompt, targetAgent, delegateSessionId, onToolUse, onProcSpawn);
    } catch (err) {
      if (delegateSessionId && (err.isSessionError || err.message?.includes('signature') || err.message?.includes('400'))) {
        console.log(`⚠️ 위임 세션 손상 → 새 세션으로 재시도`);
        if (targetChannelId) clearSession(targetChannelId);
        result = await _runClaudeOnce(task, systemPrompt, targetAgent, null, onToolUse, onProcSpawn);
      } else {
        throw err;
      }
    }

    clearInterval(typingInterval);

    // 완료 임베드
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    const timeStr = min > 0 ? `${min}분 ${sec}초` : `${sec}초`;

    if (progressMsg) {
      try {
        const completionDesc = [];
        if (toolSteps.length > 0) {
          completionDesc.push(`✅ 도구 ${toolSteps.length}회 사용하여 완료`);
          const toolCounts = {};
          for (const s of toolSteps) toolCounts[s.tool] = (toolCounts[s.tool] || 0) + 1;
          completionDesc.push(Object.entries(toolCounts).map(([t, c]) => `${TOOL_ICONS_D[t] || '⚙️'} ${t} ×${c}`).join('  '));
        } else {
          completionDesc.push('✅ 완료');
        }
        await progressMsg.edit({
          embeds: [{
            color: 0x22C55E,
            author: { name: `${agentLabel} 작업 완료` },
            description: completionDesc.join('\n'),
            footer: { text: `⏱️ ${timeStr} 소요 | 🧠 ${_delegateModelLabel}` },
          }],
        });
      } catch {}
    }

    // 위임받은 에이전트 세션 저장 (다음 위임에서 이어가기)
    if (targetChannelId && result.sessionId) {
      setSessionId(targetChannelId, result.sessionId);
    }

    // 결과 텍스트 전송
    if (result.text) {
      await sendResponseWithFiles({ channel: workChannel, reply: (c) => workChannel.send(c) }, result.text);
    }
    return result;
  } catch (err) {
    console.error(`❌ 위임 실패 [${targetAgent.name}]:`, err.message);
    if (progressMsg) {
      try {
        await progressMsg.edit({
          embeds: [{
            color: 0xEF4444,
            author: { name: `${agentLabel} 오류 발생` },
            description: `❌ ${err.message}`,
          }],
        });
      } catch {}
    }
    await workChannel.send(`❌ ${targetAgent.name} 위임 실패: ${err.message}`);
    return null;
  } finally {
    clearInterval(progressInterval);
    if (targetChannelId) {
      decrementTaskCount(targetChannelId);
    } else {
      activeRequests.delete(delegateKey);
    }
    activeProcesses.delete(delegateKey);
    totalProcessed++;
    const durationMs = Date.now() - startTime;
    taskHistory.push({ timestamp: Date.now(), durationMs });
    // 48시간 이상 된 기록 제거
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    while (taskHistory.length > 0 && taskHistory[0].timestamp < cutoff) taskHistory.shift();
    updateDashboard();
  }
}

// JSON 응답에서 delegate 패턴 감지 및 처리
async function handleDelegation(rawResponse, message) {
  // delegate 패턴 찾기: {"delegate": {"agent": "...", "task": "..."}}
  try {
    const parsed = JSON.parse(rawResponse);
    if (parsed.delegate) {
      const { agent: targetId, task } = parsed.delegate;
      if (targetId && task) {
        const sourceAgent = getAgentForChannel(message.channel.id);
        await delegateToAgent(sourceAgent?.name || '메인', targetId, task, message);
      }
      // delegate 외에 message가 있으면 그것도 전송
      if (parsed.message) {
        await sendResponseWithFiles(message, parsed.message);
      }
      return true;
    }
  } catch {
    // JSON이 아니면 tryParseJSON으로 텍스트 내 JSON 추출
    const extracted = tryParseJSON(rawResponse);
    if (extracted && extracted.parsed.delegate) {
      const { agent: targetId, task, returnResult } = extracted.parsed.delegate;
      if (targetId && task) {
        // message가 있으면 먼저 전송
        const msg = extracted.parsed.message || extracted.before;
        if (msg) await sendResponseWithFiles(message, msg);

        const sourceAgent = getAgentForChannel(message.channel.id);
        const delegatePromise = delegateToAgent(sourceAgent?.name || '메인', targetId, task, message);

        if (returnResult) {
          delegatePromise.then(result => {
            if (result?.text) {
              const agentName = loadConfig().agents?.[targetId]?.name || targetId;
              const summary = result.text.length > 1500 ? result.text.slice(0, 1500) + '...(생략)' : result.text;
              message.channel.send(`📋 **${agentName}** 작업 결과:\n${summary}`).catch(() => {});
            }
          }).catch(() => {});
        }

        if (extracted.after) await sendResponseWithFiles(message, extracted.after);
        return true;
      }
    }
  }
  return false;
}

function getAgentForChannel(channelId) {
  const config = loadConfig();
  const agentId = config.channelBindings?.[channelId] || 'default';
  return config.agents?.[agentId] || config.agents?.default || null;
}

// 에이전트가 속한 프로젝트 찾기
function getProjectForAgent(agentId) {
  const config = loadConfig();
  for (const [projId, proj] of Object.entries(config.projects || {})) {
    if (proj.agents && proj.agents.includes(agentId)) {
      return { id: projId, ...proj };
    }
  }
  return null;
}

// 프로젝트별 공유 노트 경로 (프로젝트 내 첫 에이전트의 workingDir 기준 상위)
function getSharedNotesPath(agentId) {
  const config = loadConfig();
  const proj = getProjectForAgent(agentId);
  if (!proj) return null;

  // 프로젝트에 sharedNotesPath가 명시되어 있으면 사용
  if (proj.sharedNotesPath) return proj.sharedNotesPath;

  // 없으면 프로젝트 첫 에이전트의 workingDir에서 공통 상위 경로 추정
  const firstAgent = config.agents?.[proj.agents[0]];
  if (!firstAgent?.workingDir) return null;

  // workingDir에서 src/ 이전까지를 프로젝트 루트로 사용
  const srcIdx = firstAgent.workingDir.indexOf('/src');
  const projectRoot = srcIdx > 0 ? firstAgent.workingDir.slice(0, srcIdx) : firstAgent.workingDir;
  return path.join(projectRoot, 'shared_notes.json');
}

// 세션 요약을 공유 노트에 저장
function saveSessionSummaryToNotes(agentId, summary) {
  try {
    const notesPath = getSharedNotesPath(agentId);
    if (!notesPath || !summary) return;

    let notes = {};
    if (fs.existsSync(notesPath)) {
      notes = JSON.parse(fs.readFileSync(notesPath, 'utf-8'));
    }

    if (!notes[agentId]) notes[agentId] = {};
    notes[agentId]._sessionSummary = summary;
    notes[agentId]._sessionRotatedAt = new Date().toISOString();

    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));
    console.log(`📝 공유 노트에 세션 요약 저장: ${agentId}`);
  } catch (err) {
    console.warn(`⚠️ 공유 노트 저장 실패: ${err.message}`);
  }
}

// 업데이트 체크 — 매일 오전 9시
function scheduleUpdateCheck() {
  const now = new Date();
  const next9am = new Date(now);
  next9am.setHours(9, 3, 0, 0);  // 9:03 (정각 회피)
  if (next9am <= now) next9am.setDate(next9am.getDate() + 1);
  const msUntil = next9am - now;
  console.log(`🔄 다음 업데이트 체크: ${next9am.toLocaleString('ko-KR')} (${Math.round(msUntil / 60000)}분 후)`);
  setTimeout(() => {
    checkForUpdates();
    // 이후 24시간마다
    setInterval(() => checkForUpdates(), 24 * 60 * 60 * 1000);
  }, msUntil);
}
// 시작 시에도 한번 체크
setTimeout(() => checkForUpdates(), 30 * 1000);
scheduleUpdateCheck();

client.login(process.env.DISCORD_TOKEN);
