require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// tmp 디렉토리 생성
fs.mkdirSync(TMP_DIR, { recursive: true });

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
const MESSAGE_DEDUP_TTL = 60 * 1000; // 60초 내 동일 메시지 무시

function markMessageProcessed(messageId) {
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), MESSAGE_DEDUP_TTL);
}

// ── 대화 세션 관리 (채널별 컨텍스트 유지, 디스크 영구 저장) ──────
const SESSION_FILE = path.join(__dirname, '.sessions.json');
const channelSessions = new Map(); // channelId -> { sessionId, lastUsed, turnCount, summary }
const SESSION_TTL = 0; // 수동 초기화(!reset) 전까지 세션 영구 유지
const SESSION_MAX_TURNS = 100; // 100턴 후 자동 요약 + 리셋 (0=비활성화)

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
      fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2), 'utf-8');
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
  if (SESSION_MAX_TURNS <= 0) return null;  // 0이면 비활성화
  if ((session.turnCount || 0) < SESSION_MAX_TURNS) return null;

  console.log(`🔄 세션 로테이션: ch=${channelId} turns=${session.turnCount}`);

  // 현재 세션에서 요약 추출
  try {
    const summaryResult = await _runClaudeOnce(
      '지금까지 이 채널에서 나눈 대화의 핵심 내용을 3~5줄로 요약해줘. 중요한 결정사항, 작업 진행상황, 맥락을 포함해.',
      null, agent, session.sessionId
    );
    const summary = summaryResult.text || '';
    console.log(`📝 세션 요약 완료 (${summary.length}자)`);

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

// Discord 관리 작업 지시 (Claude에게 전달)
const DISCORD_ACTIONS_PROMPT = `
## Discord 액션 시스템 (내장 기능 — 별도 도구/권한 불필요)
당신은 Discord 봇 내부에서 실행됩니다. 다른 채널에 메시지 전송, 채널/역할 관리 등은
외부 도구(MCP 등)가 아닌 아래 JSON 형식으로 응답하면 봇이 자동 실행합니다.
절대 "권한이 없다", "도구가 필요하다"고 하지 마세요. 이 기능은 항상 사용 가능합니다.

다른 채널에 메시지를 보내거나 서버 관리가 필요할 때, 반드시 아래 JSON만 응답하세요 (마크다운 코드블록 금지):
{"message": "사용자에게 보여줄 메시지", "actions": [...]}

사용 가능한 actions:
- {"type": "sendMessage", "channel": "채널명", "content": "보낼 내용"}
- {"type": "createChannel", "name": "채널명", "channelType": "text"|"voice"|"category"}
- {"type": "deleteChannel", "name": "채널명"}
- {"type": "renameChannel", "name": "현재채널명", "newName": "새이름"}
- {"type": "createRole", "name": "역할명", "color": "#FF0000"}
- {"type": "deleteRole", "name": "역할명"}

예시: 사용자가 "알림 채널에 테스트 메시지 보내줘" → 응답:
{"message": "알림 채널에 메시지를 전송했습니다.", "actions": [{"type": "sendMessage", "channel": "알림", "content": "테스트 메시지입니다."}]}

일반 대화/코딩 작업은 JSON 없이 그냥 텍스트로 답하세요.

## 에이전트 위임 (다른 에이전트에게 작업 넘기기)
작업이 다른 에이전트의 전문 영역이면, 아래 JSON으로 위임하세요:
단일 위임: {"message": "사용자 응답", "delegate": {"agent": "에이전트ID", "task": "위임할 작업 설명"}}
복수 동시 위임: {"message": "사용자 응답", "delegates": [{"agent": "에이전트ID1", "task": "작업1"}, {"agent": "에이전트ID2", "task": "작업2"}]}
여러 에이전트에게 동시에 작업을 맡길 때는 delegates 배열을 사용하세요. 모든 위임은 병렬로 실행됩니다.

파일을 전송해야 할 경우, 응답 텍스트 안에 [[FILE:/절대/경로/파일명]] 패턴을 포함하세요.
예: 리포트를 작성했습니다. [[FILE:/tmp/report.txt]]

## 중요 행동 규칙
- 사용자가 무언가를 요청하면 **확인 질문 없이 바로 실행**하세요.
- "확인하고 싶은 부분이 있습니다", "어떤 작업에 대해 물어보시는 건가요?" 같은 **되묻는 질문을 절대 하지 마세요.** 세션 컨텍스트를 확인하고 스스로 판단해서 답하세요.
- **큰 작업은 계획을 먼저 보고**하세요: "이렇게 진행하겠습니다: 1. ... 2. ... 3. ..." 형식으로 알린 뒤 바로 실행하세요. 승인을 기다리지 마세요.
- Plan 모드로 진입하지 마세요. 바로 구현하세요.
- **절대 다른 채널이나 하이브마인드에게 떠넘기지 마세요.** 당신의 채널에서 받은 요청은 당신이 끝까지 책임지세요. 모르는 부분은 파일을 읽고 분석해서 스스로 해결하세요.
- 작업이 끝나면 반드시 **무엇을 했고, 결과가 무엇인지** 구체적으로 알려주세요.
- "작업을 완료했습니다"만 말하지 말고, 핵심 내용을 요약해서 보여주세요.
- 작업 결과에는 반드시: 수정한 파일 목록, 변경 내용 요약, 테스트 결과(있으면)를 포함하세요.

## 절대 하지 말아야 할 것
- **절대로 봇 자체의 프로세스를 관리하지 마세요** (pgrep, pkill, kill, ps 등으로 node/bot.js 프로세스를 조회/종료 금지)
- 봇의 설정 파일(config.json, .env)을 삭제하거나 초기화하지 마세요
- /tmp/claude-discord-bot.pid, /tmp/claude-telegram-bot.pid 파일을 건드리지 마세요
- **도구 사용 전에 반드시 생각하세요**: 이 메시지가 도구 없이 답할 수 있는가? 대화, 인사, 질문, 안부, 의견, 감탄사 등은 **절대 도구를 사용하지 말고 바로 텍스트로 답하세요.**
- 도구(Bash, Read, Glob, Grep 등)는 **코드 수정, 파일 조회, 데이터 분석 등 실제 작업이 필요할 때만** 사용하세요.
- "~에게 안부 물어봐줘", "뭐해?", "잘 되고 있어?" 같은 메시지는 도구 호출 없이 바로 답변하거나 위임하세요.

## 대화 연속성
- 이 채널의 이전 대화 내용을 기억하고 있습니다. 같은 주제면 이어서 진행하세요.
- "이전에 말씀하신 내용을 모르겠습니다" 같은 말 대신, 세션 컨텍스트를 활용하세요.
- !reset 명령이 올 때까지 이 채널의 모든 대화는 연속됩니다.

## 응답 형식
- 한국어로 답변하세요. 사용자가 영어로 물으면 영어로 답하세요.
- 코드 블록은 언어 태그를 포함하세요 (\`\`\`python, \`\`\`javascript 등).
- 긴 응답은 구조화하세요: 제목, 불릿 포인트, 코드 블록 활용.
- Discord 마크다운을 활용하세요: **굵게**, *기울임*, \`인라인코드\`.`;

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
  const agent = config.agents[agentId] || config.agents['default'];

  // 채널 단위 동시 실행 제어 — 최대 동시 작업 수 초과 시 큐에 추가
  const currentTasks = getTaskCount(channelId);
  if (currentTasks >= MAX_CONCURRENT_PER_CHANNEL) {
    const queue = getQueue(channelId);
    if (queue.length >= 5) {
      await message.reply('⚠️ 대기열이 가득 찼습니다 (최대 5개). 현재 작업 완료 후 다시 시도해주세요.');
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

    return {
      color: 0x8B5CF6,
      author: { name: `${agentLabel} 작업 중...` },
      description,
      footer: { text: `⏱️ ${timeStr} 경과` },
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

    toolSteps.push({ icon, tool: toolName, detail });
    // 대시보드용 현재 작업 업데이트
    const proc = activeProcesses.get(taskId);
    if (proc) proc.currentTool = `${icon} ${toolName}${detail ? ': ' + detail.slice(0, 30) : ''}`;
    console.log(`  📊 [${agentLabel}] ${icon} ${toolName}${detail ? ': ' + detail : ''}`);
  };

  try {
    let systemPrompt = agent.systemPrompt + '\n\n' + DISCORD_ACTIONS_PROMPT;

    // 에이전트 위임 ID 목록 자동 주입 (config에서 동적 생성)
    const agentConfig = loadConfig();
    const agentList = Object.entries(agentConfig.agents || {})
      .filter(([id]) => id !== 'default')
      .map(([id, a]) => `${a.avatar || '🤖'} ${a.name} → \`${id}\``)
      .join('\n');
    systemPrompt += `\n\n## 위임 가능한 에이전트 (delegate 시 정확한 ID 사용)\n${agentList}`;

    // 프로젝트 공유 노트 경로 주입
    const notesPath = getSharedNotesPath(agentId);
    if (notesPath) {
      const proj = getProjectForAgent(agentId);
      systemPrompt += `\n\n## 프로젝트 공유 노트 (${proj?.name || agentId})
공유 노트 파일: \`${notesPath}\`
- 다른 에이전트들과 정보를 공유할 때 이 파일을 사용하세요.
- **읽기**: 작업 시작 시 이 파일을 읽어서 다른 에이전트가 남긴 정보를 참고하세요.
- **쓰기**: 다른 에이전트에게 알려야 할 중요한 결과(분석 결과, 생성한 파일 경로, 설정 변경 등)를 기록하세요.
- JSON 형식: {"에이전트ID": {"key": "value", "updated": "타임스탬프"}}
- 기존 내용을 덮어쓰지 말고, 자신의 에이전트ID 키만 업데이트하세요.
- 사소한 내용은 기록하지 마세요. 다른 에이전트가 참고해야 할 핵심 정보만 남기세요.`;
    }

    // 세션 턴 수 초과 시 자동 요약 + 리셋
    await maybeRotateSession(channelId, agent);

    // 이전 세션 요약이 있으면 프롬프트에 주입
    const sessionData = channelSessions.get(channelId);
    if (sessionData?.summary && !sessionData?.sessionId) {
      systemPrompt += `\n\n## 이전 대화 요약 (자동 생성)\n${sessionData.summary}`;
    }

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
      // 세션 복원 실패 시 새 세션으로 재시도
      if (sessionId) {
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
          footer: { text: `⏱️ ${timeStr} 소요` },
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
              DISCORD_ACTIONS_PROMPT, agentConfig, result.sessionId
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
              footer: { text: `⏱️ ${timeStr} 소요` },
            }] });
          } catch {}
        }

        // ④ 모든 위임 동시 실행 (병렬 — 라우터는 여기서 끝)
        const src = getAgentForChannel(channelId);
        for (const d of delegations) {
          if (d.agent && d.task) {
            delegateToAgent(src?.name || agentLabel, d.agent, d.task, message);
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
          footer: { text: `도구 ${toolSteps.length}회 사용` },
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

// ── macOS 키체인에서 OAuth 토큰 가져오기 ──
let _oauthTokenCache = null;
let _oauthTokenExpiry = 0;

function getOAuthTokenFromKeychain() {
  const now = Date.now();
  if (_oauthTokenCache && now < _oauthTokenExpiry) return _oauthTokenCache;

  // 1차: macOS 키체인에서 "Claude Code-credentials" 읽기
  const keychainServices = [
    'Claude Code-credentials',
    'claude-code-credentials',
    'claude-cli-oauth-token',
  ];
  for (const svc of keychainServices) {
    try {
      const raw = execSync(
        `security find-generic-password -s "${svc}" -w 2>/dev/null`,
        { timeout: 5000 }
      ).toString().trim();
      if (raw) {
        let token = raw;
        // JSON 형태인 경우 accessToken 추출
        if (raw.startsWith('{')) {
          try {
            const json = JSON.parse(raw);
            // {"claudeAiOauth":{"accessToken":"sk-ant-..."}} 형태
            if (json.claudeAiOauth?.accessToken) {
              token = json.claudeAiOauth.accessToken;
            } else if (json.accessToken) {
              token = json.accessToken;
            } else if (json.oauth_token) {
              token = json.oauth_token;
            }
          } catch {}
        }
        if (token && token.startsWith('sk-ant-')) {
          _oauthTokenCache = token;
          _oauthTokenExpiry = now + 5 * 60 * 1000;
          console.log(`🔑 키체인에서 OAuth 토큰 로드 (${svc})`);
          return token;
        }
      }
    } catch {}
  }

  // 2차: Claude 설정 파일에서 읽기
  try {
    const homeDir = require('os').homedir();
    const credPaths = [
      `${homeDir}/.claude/credentials.json`,
      `${homeDir}/.config/claude/credentials.json`,
    ];
    for (const p of credPaths) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const token = data.claudeAiOauth?.accessToken || data.oauth_token || data.accessToken || data.token;
        if (token) {
          _oauthTokenCache = token;
          _oauthTokenExpiry = now + 5 * 60 * 1000;
          console.log(`🔑 설정 파일에서 OAuth 토큰 로드: ${p}`);
          return token;
        }
      } catch {}
    }
  } catch {}

  return null;
}

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

    // OAuth 토큰: Claude CLI가 자체적으로 키체인에서 읽고 refresh하도록 함
    // 봇이 만료된 토큰을 주입하면 CLI가 refresh를 안 하므로, 환경변수를 제거
    delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;

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
    const disallowed = [
      'Bash(kill:*)', 'Bash(pkill:*)', 'Bash(pgrep:*)',
      'Bash(killall:*)', 'Bash(launchctl:*)',
      'Bash(rm -rf /Volumes:*)', 'Bash(rm -rf ~:*)'
    ];

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
      if (settled) return;
      settled = true;
      reject(new Error(`Claude 실행 실패: ${err.message}`));
    });
  });
}

async function runClaude(prompt, systemPrompt, agent = {}, sessionId = null, onToolUse = null, onProcSpawn = null) {
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
  const jsonStart = raw.indexOf('{"');
  if (jsonStart === -1) return null;

  // JSON 끝 찾기: 중괄호 매칭
  let depth = 0;
  let jsonEnd = -1;
  for (let i = jsonStart; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) { jsonEnd = i + 1; break; }
    }
  }
  if (jsonEnd === -1) return null;

  try {
    const jsonStr = raw.slice(jsonStart, jsonEnd);
    const parsed = JSON.parse(jsonStr);
    if (parsed.message || parsed.actions || parsed.delegate) {
      const before = raw.slice(0, jsonStart).trim();
      const after = raw.slice(jsonEnd).trim();
      return { parsed, before, after };
    }
  } catch {}

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
    const files = filePaths
      .filter(p => {
        if (!fs.existsSync(p)) {
          console.warn(`파일 없음: ${p}`);
          return false;
        }
        return true;
      })
      .map(p => ({
        attachment: p,
        name: path.basename(p),
      }));

    if (files.length > 0) {
      try {
        await message.channel.send({ files });
        console.log(`📤 파일 전송: ${files.map(f => f.name).join(', ')}`);
      } catch (err) {
        console.error('파일 전송 실패:', err.message);
        await message.channel.send(`❌ 파일 전송 실패: ${err.message}`);
      }
    }
  }
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

      // 채널 찾기 또는 생성
      let channel = guild.channels.cache.find(
        ch => ch.name === channelName && ch.type === ChannelType.GuildText
      );

      if (!channel) {
        channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: `${proj.emoji} ${proj.name} 에이전트 실시간 대시보드`,
          reason: 'Claude Bot 대시보드 자동 생성',
        });
        console.log(`📊 대시보드 채널 생성: #${channelName}`);
      }

      // 기존 봇 메시지 찾기
      const messages = await channel.messages.fetch({ limit: 10 });
      const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
      let message;

      if (botMsg) {
        message = botMsg;
        console.log(`📊 [${proj.name}] 기존 대시보드 재사용`);
      } else {
        const embed = buildProjectEmbed(projId, proj, config);
        message = await channel.send({ embeds: [embed] });
        try { await message.pin(); } catch {}
        console.log(`📊 [${proj.name}] 대시보드 생성 및 고정`);
      }

      dashboards.set(projId, { channel, message, lastState: '', project: proj });
    }

    // 대시보드 채널에 사용자 메시지 오면 자동 삭제 (동적 체크)
    client.on('messageCreate', async (msg) => {
      if (msg.author.bot) return;
      const isDashChannel = [...dashboards.values()].some(d => d.channel.id === msg.channelId);
      if (isDashChannel) {
        try { await msg.delete(); } catch {}
      }
    });

    // 5초마다 전체 업데이트
    setInterval(() => updateAllDashboards(), 5000);
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
## v2.9.16
- 📝 프로젝트별 공유 노트 시스템 (shared_notes.json)
- 에이전트 간 핵심 정보 공유 (분석 결과, 파일 경로, 설정 변경 등)
- 프로젝트 루트 자동 감지, 시스템 프롬프트에 사용법 자동 주입

## v2.9.15
- 🔀 컨텍스트 합류 큐: 작업 중 들어온 메시지를 합쳐서 이전 세션에서 이어 처리
- 🔧 대시보드 위임 상태 미감지 버그 수정
- ⚡ taskId 기반 프로세스 추적으로 키 충돌 방지

## v2.9.14
- 🔀 채널별 병렬 작업 지원 (MAX_CONCURRENT_PER_CHANNEL)
- 🛑 !stop으로 채널 내 모든 활성 작업 중단
- 📊 대시보드에 동시 작업 수 표시 (⚡×N)

## v2.9.13
- 🔗 자동 업데이트 URL 하드코드 fallback 추가

## v2.9.12
- 🔄 자동 업데이트 시스템 수정
- 🤝 병렬 다중 에이전트 위임 지원
CHANGELOG_END*/

// ─────────────────────────────────────────
//  🔄 자동 업데이트 시스템
// ─────────────────────────────────────────
// config.json에 updateUrl 설정 시 매일 체크:
// "updateUrl": "https://raw.githubusercontent.com/user/repo/main/bot.js"
// 또는 로컬 서버: "updateUrl": "http://192.168.x.x:8080/bot.js"

const UPDATE_CHECK_FILE = path.join(__dirname, '.update-check');
const BOT_VERSION = '2.9.16';

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

      // 변경사항 추출 (CHANGELOG 블록에서 새 버전 내역만)
      let changelog = '';
      const clBlock = remoteCode.match(/\/\*CHANGELOG_START\n([\s\S]*?)CHANGELOG_END\*\//);
      if (clBlock) {
        // 새 버전의 섹션만 추출 (## vX.X.X ~ 다음 ## 전까지)
        const sections = clBlock[1].split(/^## /m).filter(s => s.trim());
        // 현재 버전보다 새로운 섹션들만 모으기
        const newSections = [];
        for (const sec of sections) {
          const verMatch = sec.match(/^v?([\d.]+)/);
          if (verMatch && verMatch[1] !== BOT_VERSION) {
            // 버전 비교: 새 버전이면 포함
            const lines = sec.trim().split('\n');
            const verTitle = lines[0].trim();
            const items = lines.slice(1).map(l => l.trim()).filter(l => l.startsWith('-'));
            if (items.length > 0) {
              newSections.push(`**v${verTitle}**\n${items.join('\n')}`);
            }
          }
        }
        changelog = newSections.length > 0 ? newSections.join('\n\n') : '변경 내역 없음';
      } else {
        // fallback: 기존 한줄 방식
        const changelogMatch = remoteCode.match(/\/\/ CHANGELOG: (.+)/);
        changelog = changelogMatch ? changelogMatch[1] : '변경 내역 없음';
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

  // 위임받은 채널에 진행 임베드 표시
  let progressMsg = null;
  try {
    progressMsg = await workChannel.send({
      embeds: [{
        color: 0x8B5CF6,
        author: { name: `${agentLabel} 작업 중...` },
        description: `🤝 **${sourceAgent}**로부터 위임받은 작업\n🔍 분석 중... (도구 0회 사용)\n\n\`${task.slice(0, 150)}\``,
        footer: { text: '⏱️ 0초 경과' },
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
          footer: { text: `⏱️ ${timeStr} 경과` },
        }],
      });
    } catch {}
  }, 3000);

  const systemPrompt = targetAgent.systemPrompt + '\n\n' + DISCORD_ACTIONS_PROMPT;

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

    const result = await _runClaudeOnce(task, systemPrompt, targetAgent, null, onToolUse, onProcSpawn);

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
            footer: { text: `⏱️ ${timeStr} 소요` },
          }],
        });
      } catch {}
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
    // JSON이 아니면 텍스트에서 delegate 패턴 검색
    const delegateMatch = rawResponse.match(/\{"delegate":\s*\{[^}]+\}\}/);
    if (delegateMatch) {
      try {
        const delegateJson = JSON.parse(delegateMatch[0]);
        const { agent: targetId, task } = delegateJson.delegate;
        if (targetId && task) {
          const sourceAgent = getAgentForChannel(message.channel.id);
          await delegateToAgent(sourceAgent?.name || '메인', targetId, task, message);
          // delegate 부분 제거한 나머지 텍스트 전송
          const remaining = rawResponse.replace(delegateMatch[0], '').trim();
          if (remaining) await sendResponseWithFiles(message, remaining);
          return true;
        }
      } catch {}
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
