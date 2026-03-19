require('dotenv').config();
const { Bot, InputFile } = require('grammy');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ─────────────────────────────────────────
//  단일 인스턴스 보장 (PID Lock)
// ─────────────────────────────────────────
const LOCK_FILE = '/tmp/claude-telegram-bot.pid';

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (existingPid && !isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0);
          console.log(`⚠️ 이전 인스턴스 발견 (PID: ${existingPid}), 종료 시도...`);
          process.kill(existingPid, 'SIGTERM');
          try {
            const start = Date.now();
            while (Date.now() - start < 3000) {
              try { process.kill(existingPid, 0); } catch { break; }
            }
            try { process.kill(existingPid, 'SIGKILL'); } catch {}
          } catch {}
          console.log(`✅ 이전 인스턴스 (PID: ${existingPid}) 종료 완료`);
        } catch {
          console.log(`🧹 Stale lock 파일 정리 (PID: ${existingPid} 이미 종료됨)`);
        }
      }
    }
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
      if (pid === process.pid.toString()) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

acquireLock();
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

// ─────────────────────────────────────────
//  설정 파일 로드/저장
// ─────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const TMP_DIR = '/tmp/claude-telegram';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

fs.mkdirSync(TMP_DIR, { recursive: true });

// ─────────────────────────────────────────
//  Telegram Bot 초기화
// ─────────────────────────────────────────
const bot = new Bot(process.env.TELEGRAM_TOKEN);

const MAX_MESSAGE_LENGTH = 4000; // Telegram 4096자 제한 (여유분 확보)
const activeRequests = new Set();

// ── 메시지 중복 처리 방지 ──────
const processedMessages = new Set();
const MESSAGE_DEDUP_TTL = 60 * 1000;

function markMessageProcessed(messageId) {
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), MESSAGE_DEDUP_TTL);
}

// ── 대화 세션 관리 (채팅별 컨텍스트 유지) ──────
const chatSessions = new Map(); // chatId -> { sessionId, lastUsed }
const SESSION_TTL = 0; // 수동 초기화(/reset) 전까지 세션 영구 유지

function getSessionId(chatId) {
  const session = chatSessions.get(chatId);
  if (!session) return null;
  if (SESSION_TTL > 0 && Date.now() - session.lastUsed > SESSION_TTL) {
    chatSessions.delete(chatId);
    console.log(`🧹 세션 만료 정리: chatId=${chatId}`);
    return null;
  }
  session.lastUsed = Date.now();
  return session.sessionId;
}

function setSessionId(chatId, sessionId) {
  chatSessions.set(chatId, { sessionId, lastUsed: Date.now() });
}

function clearSession(chatId) {
  chatSessions.delete(chatId);
}

// ─────────────────────────────────────────
//  명령어 핸들러
// ─────────────────────────────────────────

// /start — 봇 소개
bot.command('start', async (ctx) => {
  await ctx.reply(
    '🤖 *Claude Bot*\n\n' +
    'Claude Code CLI를 Telegram에서 사용할 수 있는 봇입니다.\n\n' +
    '*명령어:*\n' +
    '`/claude <메시지>` — Claude에게 질문\n' +
    '`/reset` — 대화 세션 초기화\n' +
    '`/agent_list` — 에이전트 목록\n' +
    '`/agent_create <id> <이름> | <프롬프트>` — 에이전트 생성\n' +
    '`/agent_bind <에이전트ID>` — 이 채팅에 에이전트 바인딩\n' +
    '`/agent_unbind` — 바인딩 해제\n' +
    '`/agent_info <id>` — 에이전트 상세 정보\n\n' +
    '💡 바인딩된 채팅에서는 접두사 없이 바로 메시지를 보내면 됩니다.',
    { parse_mode: 'Markdown' }
  );
});

// /reset — 세션 초기화
bot.command('reset', async (ctx) => {
  clearSession(ctx.chat.id.toString());
  await ctx.reply('🔄 대화 세션이 초기화되었습니다. 새로운 대화를 시작합니다.');
});

// /claude — Claude에게 질문
bot.command('claude', async (ctx) => {
  const prompt = ctx.match?.trim();
  if (!prompt) {
    await ctx.reply('사용법: `/claude <질문 또는 요청>`', { parse_mode: 'Markdown' });
    return;
  }
  await handleClaude(ctx, prompt);
});

// /agent_list — 에이전트 목록
bot.command('agent_list', async (ctx) => {
  const config = loadConfig();
  const agents = config.agents || {};
  const chatBindings = config.chatBindings || {};

  const lines = Object.entries(agents).map(([id, a]) => {
    const boundChats = Object.entries(chatBindings)
      .filter(([, aid]) => aid === id)
      .map(([cid]) => cid)
      .join(', ') || '없음';
    return `${a.avatar || '🤖'} *${a.name}* (\`${id}\`) — 바인딩: ${boundChats}`;
  });

  await ctx.reply(
    `*에이전트 목록 (${Object.keys(agents).length}개):*\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
});

// /agent_create <id> <이름> | <시스템프롬프트>
bot.command('agent_create', async (ctx) => {
  const rest = ctx.match?.trim();
  if (!rest) {
    await ctx.reply('사용법: `/agent_create <id> <이름> | <시스템프롬프트>`', { parse_mode: 'Markdown' });
    return;
  }

  const [idAndName, ...promptParts] = rest.split('|');
  const [id, ...nameParts] = idAndName.trim().split(' ');
  const name = nameParts.join(' ').trim();
  const systemPrompt = promptParts.join('|').trim();

  if (!id || !name || !systemPrompt) {
    await ctx.reply('사용법: `/agent_create <id> <이름> | <시스템프롬프트>`\n예) `/agent_create helper 친절한봇 | 당신은 친절한 도우미입니다`', { parse_mode: 'Markdown' });
    return;
  }

  const config = loadConfig();
  config.agents[id] = {
    name,
    avatar: '🤖',
    systemPrompt,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
    timeout: 300000,
  };
  saveConfig(config);
  await ctx.reply(`✅ 에이전트 *${name}* (\`${id}\`) 생성 완료!`, { parse_mode: 'Markdown' });
});

// /agent_delete <id>
bot.command('agent_delete', async (ctx) => {
  const id = ctx.match?.trim();
  if (!id || id === 'default') {
    await ctx.reply('❌ 에이전트 ID를 입력하세요. (default는 삭제 불가)');
    return;
  }
  const config = loadConfig();
  if (!config.agents[id]) {
    await ctx.reply(`❌ \`${id}\` 에이전트가 없습니다.`, { parse_mode: 'Markdown' });
    return;
  }
  delete config.agents[id];
  if (!config.chatBindings) config.chatBindings = {};
  for (const [cid, aid] of Object.entries(config.chatBindings)) {
    if (aid === id) delete config.chatBindings[cid];
  }
  saveConfig(config);
  await ctx.reply(`✅ \`${id}\` 에이전트 삭제 완료`, { parse_mode: 'Markdown' });
});

// /agent_bind <agentId>
bot.command('agent_bind', async (ctx) => {
  const agentId = ctx.match?.trim();
  if (!agentId) {
    await ctx.reply('사용법: `/agent_bind <에이전트ID>`', { parse_mode: 'Markdown' });
    return;
  }
  const config = loadConfig();
  if (!config.agents[agentId]) {
    await ctx.reply(`❌ \`${agentId}\` 에이전트가 없습니다. \`/agent_list\`로 확인하세요.`, { parse_mode: 'Markdown' });
    return;
  }

  if (!config.chatBindings) config.chatBindings = {};
  config.chatBindings[ctx.chat.id.toString()] = agentId;
  saveConfig(config);
  const agent = config.agents[agentId];
  await ctx.reply(
    `✅ 이 채팅 → *${agent.name}* 바인딩 완료!\n메시지를 보내면 ${agent.avatar || '🤖'} *${agent.name}*가 자동 응답합니다.`,
    { parse_mode: 'Markdown' }
  );
});

// /agent_unbind
bot.command('agent_unbind', async (ctx) => {
  const config = loadConfig();
  if (!config.chatBindings) config.chatBindings = {};
  delete config.chatBindings[ctx.chat.id.toString()];
  saveConfig(config);
  await ctx.reply('✅ 바인딩 해제 완료');
});

// /agent_info <id>
bot.command('agent_info', async (ctx) => {
  const id = ctx.match?.trim();
  if (!id) { await ctx.reply('사용법: `/agent_info <id>`', { parse_mode: 'Markdown' }); return; }
  const config = loadConfig();
  const agent = config.agents?.[id];
  if (!agent) { await ctx.reply(`❌ \`${id}\` 에이전트가 없습니다.`, { parse_mode: 'Markdown' }); return; }
  const tools = agent.allowedTools?.join(', ') || '없음';
  const wdir = agent.workingDir || '없음';
  const timeout = agent.timeout ? `${agent.timeout / 1000}초` : '기본';
  await ctx.reply(
    `*${agent.avatar || '🤖'} ${agent.name}* (\`${id}\`)\n` +
    `*작업 경로:* \`${wdir}\`\n` +
    `*허용 도구:* ${tools}\n` +
    `*타임아웃:* ${timeout}\n` +
    `*시스템 프롬프트:*\n\`\`\`\n${agent.systemPrompt.slice(0, 800)}\n\`\`\``,
    { parse_mode: 'Markdown' }
  );
});

// /agent_setdir <id> <경로>
bot.command('agent_setdir', async (ctx) => {
  const rest = ctx.match?.trim();
  if (!rest) { await ctx.reply('사용법: `/agent_setdir <id> <경로>`', { parse_mode: 'Markdown' }); return; }
  const [id, ...dirParts] = rest.split(' ');
  const dir = dirParts.join(' ');
  if (!dir) { await ctx.reply('사용법: `/agent_setdir <id> <경로>`', { parse_mode: 'Markdown' }); return; }
  const config = loadConfig();
  if (!config.agents[id]) { await ctx.reply(`❌ \`${id}\` 에이전트가 없습니다.`, { parse_mode: 'Markdown' }); return; }
  config.agents[id].workingDir = dir;
  saveConfig(config);
  await ctx.reply(`✅ \`${id}\` 작업 경로 → \`${dir}\``, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────
//  자동 응답 (모든 채팅 — 바인딩 없으면 default 에이전트)
// ─────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  // 명령어는 이미 위에서 처리됨
  if (ctx.message.text.startsWith('/')) return;

  // 모든 메시지에 응답 (바인딩 없으면 default 에이전트 사용)
  await handleClaude(ctx, ctx.message.text);
});

// ── 파일 첨부 처리 ──
bot.on('message:document', async (ctx) => {
  const caption = ctx.message.caption || '';
  const prompt = caption.replace(/^\/claude\s*/, '').trim();
  await handleClaudeWithFile(ctx, prompt || '이 파일을 분석해주세요.');
});

// ─────────────────────────────────────────
//  Claude 호출 처리
// ─────────────────────────────────────────
async function handleClaude(ctx, prompt) {
  const chatId = ctx.chat.id.toString();

  if (!prompt) {
    await ctx.reply('사용법: `/claude <질문 또는 요청>` (또는 바인딩 채팅에서 바로 메시지)', { parse_mode: 'Markdown' });
    return;
  }

  // 동시 요청 차단
  if (activeRequests.has(chatId)) {
    await ctx.reply('⏳ 이전 요청 처리 중입니다. 완료 후 다시 시도해주세요.');
    return;
  }

  activeRequests.add(chatId);

  // 타이핑 표시
  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  await ctx.api.sendChatAction(chatId, 'typing').catch(() => {});

  // 에이전트 찾기
  const config = loadConfig();
  const chatBindings = config.chatBindings || {};
  const agentId = chatBindings[chatId] || 'default';
  const agent = config.agents[agentId] || config.agents['default'];

  // 에이전트 이름 표시
  if (agentId !== 'default') {
    await ctx.reply(`${agent.avatar || '🤖'} *${agent.name}* 작업 중...`, { parse_mode: 'Markdown' });
  }

  try {
    const systemPrompt = agent.systemPrompt;

    let sessionId = getSessionId(chatId);
    let result;

    try {
      result = await runClaude(prompt, systemPrompt, agent, sessionId);
    } catch (error) {
      if (sessionId) {
        console.log(`⚠️ 세션 복원 실패 (${sessionId.slice(0, 8)}...), 새 세션으로 재시도: ${error.message}`);
        clearSession(chatId);
        result = await runClaude(prompt, systemPrompt, agent, null);
      } else {
        throw error;
      }
    }

    if (result.sessionId) {
      setSessionId(chatId, result.sessionId);
      console.log(`💾 세션 저장: chat=${chatId} session=${result.sessionId.slice(0, 8)}...`);
    }

    const rawResponse = result.text;

    if (!rawResponse || !rawResponse.trim()) {
      console.log(`⚠️ Claude 빈 응답 — 무시 (session=${result.sessionId?.slice(0, 8) || 'none'})`);
      return;
    }

    // 파일 패턴 처리
    await sendResponseWithFiles(ctx, chatId, rawResponse);
  } catch (error) {
    console.error('오류:', error.message);
    await ctx.reply(`❌ 오류: ${error.message}`);
  } finally {
    clearInterval(typingInterval);
    activeRequests.delete(chatId);
  }
}

async function handleClaudeWithFile(ctx, additionalPrompt) {
  const doc = ctx.message.document;
  if (!doc) return;

  try {
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

    const timestamp = Date.now();
    const safeName = `${timestamp}_${doc.file_name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const tmpPath = path.join(TMP_DIR, safeName);

    await downloadFile(fileUrl, tmpPath);
    console.log(`📎 첨부파일 다운로드: ${doc.file_name} → ${tmpPath} (${doc.file_size} bytes)`);

    let prompt = '';
    if (isTextFile(doc.file_name, doc.mime_type)) {
      let textContent = fs.readFileSync(tmpPath, 'utf-8');
      if (textContent.length > 10000) {
        textContent = textContent.slice(0, 10000) + '\n... (10,000자 이후 생략)';
      }
      prompt = `[첨부 텍스트 파일: ${doc.file_name}]\n\`\`\`\n${textContent}\n\`\`\``;
    } else {
      prompt = `[첨부 파일: ${doc.file_name} → ${tmpPath}]`;
    }

    if (additionalPrompt) prompt += `\n\n${additionalPrompt}`;

    await handleClaude(ctx, prompt);
  } catch (err) {
    console.error(`첨부파일 처리 실패: ${doc.file_name}`, err.message);
    await ctx.reply(`❌ 파일 처리 실패: ${err.message}`);
  }
}

// ─────────────────────────────────────────
//  Claude CLI 실행 (bot.js와 동일 패턴)
// ─────────────────────────────────────────
let _authFailed = false;
let _authFailNotified = false;

function getAuthAlertChat() {
  try {
    const config = loadConfig();
    const chatIds = Object.keys(config.chatBindings || {});
    return chatIds.length > 0 ? chatIds[0] : null;
  } catch {}
  return null;
}

function isAuthError(output, stderrOutput) {
  const combined = (output + ' ' + stderrOutput).toLowerCase();
  return combined.includes('authentication_error')
    || combined.includes('oauth token has expired')
    || combined.includes('401')
    || combined.includes('failed to authenticate');
}

async function notifyAuthFailure() {
  if (_authFailNotified) return;
  _authFailNotified = true;
  try {
    const chatId = getAuthAlertChat();
    if (chatId) {
      await bot.api.sendMessage(chatId,
        '🔴 *Claude CLI 인증 만료*\n\n' +
        'OAuth 토큰이 만료되어 봇이 응답할 수 없습니다.\n' +
        '터미널에서 `claude auth login`을 실행하여 재인증해주세요.\n\n' +
        '재인증 후 봇은 자동으로 복구됩니다.',
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error('인증 알림 전송 실패:', err.message);
  }
}

function _runClaudeOnce(prompt, systemPrompt, agent = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stderrChunks = [];
    let settled = false;

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    const args = ['-p', '--output-format', 'json'];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (agent.allowedTools && agent.allowedTools.length > 0) {
      args.push('--allowedTools', agent.allowedTools.join(','));
    }

    args.push('--append-system-prompt', systemPrompt, prompt);

    const cwd = agent.workingDir || process.cwd();

    console.log(`🚀 Claude 호출: agent=${agent.name || 'default'} cwd=${cwd} session=${sessionId ? sessionId.slice(0, 8) + '...' : 'new'}`);

    const proc = spawn('claude', args, {
      env: cleanEnv,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d) => chunks.push(d.toString()));
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderrChunks.push(text);
      console.error('stderr:', text);
    });

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

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Claude 실행 실패: ${err.message}`));
    });
  });
}

async function runClaude(prompt, systemPrompt, agent = {}, sessionId = null) {
  if (_authFailed) {
    throw new Error('🔴 Claude 인증이 만료되었습니다. 터미널에서 `claude auth login`을 실행해주세요.');
  }

  try {
    return await _runClaudeOnce(prompt, systemPrompt, agent, sessionId);
  } catch (err) {
    if (!err.isAuthError) throw err;

    console.warn('⚠️ 인증 오류 감지, 5초 후 재시도...');
    await new Promise(r => setTimeout(r, 5000));

    try {
      const result = await _runClaudeOnce(prompt, systemPrompt, agent, sessionId);
      console.log('✅ 재시도 성공 — 인증 자동 갱신됨');
      return result;
    } catch (retryErr) {
      if (retryErr.isAuthError) {
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
    const status = execSync('claude auth status', { env, timeout: 10000 }).toString();
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
        const chatId = getAuthAlertChat();
        if (chatId) await bot.api.sendMessage(chatId, '🟢 *Claude 인증 복구됨* — 정상 동작합니다.', { parse_mode: 'Markdown' });
      } catch {}
    }
  } catch (err) {
    console.warn('⚠️ 인증 상태 체크 실패:', err.message);
  }
}, 30 * 60 * 1000);

// ─────────────────────────────────────────
//  응답 전송 (파일 감지 + 길이 분할)
// ─────────────────────────────────────────
async function sendResponseWithFiles(ctx, chatId, response) {
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
    await sendResponse(ctx, cleanText);
  }

  // 파일 전송
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      console.warn(`파일 없음: ${filePath}`);
      continue;
    }
    try {
      await ctx.replyWithDocument(new InputFile(filePath));
      console.log(`📤 파일 전송: ${path.basename(filePath)}`);
    } catch (err) {
      console.error('파일 전송 실패:', err.message);
      await ctx.reply(`❌ 파일 전송 실패: ${err.message}`);
    }
  }
}

async function sendResponse(ctx, response) {
  if (!response?.trim()) return;
  if (response.length <= MAX_MESSAGE_LENGTH) {
    await ctx.reply(response);
    return;
  }
  const parts = splitMessage(response);
  for (let i = 0; i < parts.length; i++) {
    const content = parts.length > 1 ? `*[${i + 1}/${parts.length}]*\n${parts[i]}` : parts[i];
    await ctx.reply(content, { parse_mode: 'Markdown' }).catch(() => {
      // Markdown 파싱 실패 시 plain text로 재시도
      ctx.reply(content);
    });
  }
}

function splitMessage(text) {
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) { parts.push(remaining); break; }
    let idx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (idx === -1 || idx < MAX_MESSAGE_LENGTH / 2) idx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    if (idx === -1 || idx < MAX_MESSAGE_LENGTH / 2) idx = MAX_MESSAGE_LENGTH;
    parts.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return parts;
}

// ─────────────────────────────────────────
//  유틸리티
// ─────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
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

// ── tmp 파일 정리 (1시간마다) ──
setInterval(() => {
  try {
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(TMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ tmp 정리: ${file}`);
      }
    }
  } catch {}
}, 3600000);

// ─────────────────────────────────────────
//  봇 시작
// ─────────────────────────────────────────
bot.start({
  onStart: (botInfo) => {
    const config = loadConfig();
    const chatBindingCount = Object.keys(config.chatBindings || {}).length;
    console.log(`✅ 텔레그램 봇 로그인 완료: @${botInfo.username}`);
    console.log(`📌 채팅 바인딩: ${chatBindingCount}개`);
    console.log(`🤖 에이전트: ${Object.keys(config.agents).length}개`);
    console.log(`📌 /claude <메시지>  — 일반 명령`);
    console.log(`🤖 /agent_list       — 에이전트 관리`);
    console.log(`💡 바인딩 채팅에서는 자동 응답 (접두사 불필요)`);
  },
});
