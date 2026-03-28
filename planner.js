#!/usr/bin/env node
/**
 * 기획자 봇 — 사용자와 대화 → 작업 정리 → 확인 후 각 에이전트 채널에 전달
 */

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 설정 ──
const TOKEN = process.env.PLANNER_BOT_TOKEN || (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).plannerToken; } catch { return ''; } })();
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CLAUDE_BIN = '/usr/local/bin/claude';

const PLANNER_CHANNELS = new Set([
  '1478907596579540992', '1479000426832592997', '1485518493909778442',
  '1486023050150543401', '1486023062687191201', '1485518439228375212',
  '1484449851579175027',
]);

function loadChannelMap() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const map = {};
    for (const [chId, agentId] of Object.entries(config.channelBindings || {})) {
      const agent = config.agents?.[agentId];
      if (agent) map[agentId] = { channelId: chId, name: agent.name || agentId, avatar: agent.avatar || '🤖' };
    }
    return map;
  } catch { return {}; }
}

// ── Claude CLI (stream-json) ──
function callClaude(prompt, systemPrompt, onToolUse) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--model', 'sonnet',
      '--disallowedTools', 'Write', 'Edit', 'Bash', 'Agent', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit',
      '--append-system-prompt', systemPrompt, prompt];
    const cleanEnv = { ...process.env, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin' };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const proc = spawn(CLAUDE_BIN, args, { env: cleanEnv, cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });

    let buffer = '';
    let resultText = null;
    let resultSessionId = null;
    let lastAssistantText = '';

    proc.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'tool_use' && ev.tool && onToolUse) onToolUse(ev.tool, ev.input || {});
          if (ev.type === 'assistant' && ev.message) lastAssistantText = ev.message;
          if (ev.type === 'result') { resultSessionId = ev.session_id; resultText = ev.result || null; }
        } catch {}
      }
    });
    let stderrBuf = '';
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('타임아웃 (30분)')); }, 1800000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      // result 이벤트가 없으면 fallback 순서: 잔여 버퍼 → lastAssistantText → stderr 추출
      if (!resultText) {
        // 1) stdout 잔여 버퍼
        if (buffer.trim()) {
          try {
            const ev = JSON.parse(buffer.trim());
            if (ev.type === 'result' && ev.result) resultText = ev.result;
            else if (ev.type === 'assistant' && ev.message) resultText = ev.message;
          } catch {}
        }
        // 2) 마지막 assistant 이벤트
        if (!resultText && lastAssistantText) {
          console.log(`  ⚠️ [기획자] result 없음 (exit ${code}), assistant fallback 사용`);
          resultText = lastAssistantText;
        }
        // 3) stderr에서 복구
        if (!resultText && stderrBuf) {
          console.error(`  ⚠️ [기획자] no result/assistant (exit ${code}), stderr 복구 시도`);
          try {
            const m = stderrBuf.match(/\{[\s\S]*"tasks"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
            if (m) resultText = m[0];
          } catch {}
          if (!resultText) console.error(`  ❌ [기획자] 복구 실패. stderr 끝:`, stderrBuf.slice(-300));
        }
      }
      resolve({ text: resultText || '', sessionId: resultSessionId });
    });
  });
}

// ── 시스템 프롬프트 ──
function buildSystemPrompt() {
  const channelMap = loadChannelMap();
  const agentList = Object.entries(channelMap).map(([id, a]) => `  ${a.avatar} ${a.name} → ${id}`).join('\n');

  return `당신은 시니어 개발자 겸 프로젝트 기획자입니다.

## 핵심 원칙
1. 사용자가 문제를 말하면 → 먼저 코드를 읽고 분석 (Read, Glob, Grep 사용)
2. 분석 결과를 사용자에게 설명 — "이 파일의 이 함수가 원인입니다"
3. 분석이 끝나면 확인 없이 바로 JSON을 출력한다. "전달할까요?"라고 묻지 않는다.
4. 이슈가 여러 개면 반드시 이슈별로 tasks 배열에 개별 항목으로 분리한다. 같은 에이전트라도 이슈별로 따로 넣는다.

## 절대 하지 말 것
- 코드를 읽지 않고 바로 전달하기
- "전달할까요?" 묻기 (분석 끝나면 바로 JSON 출력)
- 여러 이슈를 하나의 task로 합치기 (반드시 이슈별 분리)
- "~할 수 있습니다" 같은 뜬구름 답변

## 대화 예시
사용자: "피보나치 3가지 이슈 수정해줘: 1) 배경 클릭 안됨, 2) 소수점 길어, 3) 숨김 레벨 표시됨"
기획자: (Read/Grep으로 코드 분석 후, 바로 JSON 출력 — "전달할까요?" 묻지 않음)
{"reply": "3개 이슈 분석 완료", "tasks": [
  {"agent": "cf_drawing", "message": "이슈1: 배경 클릭 — hitTest에 배경 영역 추가..."},
  {"agent": "cf_drawing", "message": "이슈2: 소수점 — toFixed(3) 적용..."},
  {"agent": "cf_drawing", "message": "이슈3: 숨김 레벨 — .filter 추가..."}
]}

## 전달 형식
분석이 끝나면 바로, 코드블록 없이 순수 JSON:
{"reply": "요약 메시지", "tasks": [{"agent": "에이전트ID", "message": "구체적 지시"}]}

## 핵심 규칙
- 이슈 N개면 tasks 배열에 N개 항목 (같은 에이전트라도 이슈별 분리!)
- message에 반드시 파일경로 + 수정할 부분 + 방향 포함
- message 500자 이내 (코드블록/diff 금지, 자연어 설명)
- 에이전트가 모를 수 있는 컨텍스트 포함 (왜 이렇게 해야 하는지)

## 에이전트
${agentList}`;
}

// ── Discord ──
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const conversationHistory = new Map();
const busyChannels = new Set();
const messageQueues = new Map(); // channelId → [{ message, content }]

// 진행 임베드 (코드 분석 피드백)
const TOOL_LABELS = { Read: '파일 읽기', Glob: '파일 탐색', Grep: '코드 검색' };
const TOOL_ICONS = { Read: '📖', Glob: '📂', Grep: '🔎' };
function makeProgressEmbed(startTime, toolSteps) {
  const sec = Math.round((Date.now() - startTime) / 1000);
  const timeStr = sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
  const last = toolSteps[toolSteps.length - 1];
  const desc = last
    ? `${TOOL_ICONS[last.tool] || '⚙️'} **${TOOL_LABELS[last.tool] || last.tool}** — ${last.detail || ''}`
    : '💭 요청을 분석하고 있습니다...';
  return { color: 0xF59E0B, author: { name: '🎯 기획자 코드 분석 중...' }, description: desc, footer: { text: `⏱️ ${timeStr} | 🧠 Claude Sonnet 4.6 | 🔧 ${toolSteps.length}회` } };
}

function addHistory(chId, role, content) {
  if (!conversationHistory.has(chId)) conversationHistory.set(chId, []);
  const h = conversationHistory.get(chId);
  h.push({ role, content: content.slice(0, 500) });
  if (h.length > 10) h.shift();
}
function getHistoryPrompt(chId) {
  const h = conversationHistory.get(chId) || [];
  return h.length ? '\n\n## 이전 대화\n' + h.map(e => `${e.role}: ${e.content}`).join('\n') : '';
}

// (진행 임베드 불필요 — 기획자는 도구 사용 안 함)

// ── 작업 확인 카드 전송 ──
async function sendTaskCard(channel, task, agentInfo, index, total) {
  const taskId = `task_${Date.now()}_${index}`;

  const embed = {
    color: 0x3B82F6,
    author: { name: `📋 전달 확인 (${index + 1}/${total})` },
    description: `**대상:** ${agentInfo.avatar} ${agentInfo.name}\n**채널:** <#${agentInfo.channelId}>\n\n**내용:**\n${task.message}`,
    footer: { text: '✅ 전달 | ✏️ 수정 후 전달 | ❌ 취소' },
  };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`plan_send_${taskId}`).setLabel('전달').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`plan_edit_${taskId}`).setLabel('수정').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
    new ButtonBuilder().setCustomId(`plan_skip_${taskId}`).setLabel('취소').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
  );

  const cardMsg = await channel.send({ embeds: [embed], components: [row] });

  return new Promise((resolve) => {
    const collector = cardMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });

    collector.on('collect', async (btn) => {
      // ⚠️ Modal 분기는 deferUpdate 하면 안 됨 — 분기별 처리
      if (btn.customId.startsWith('plan_edit_')) {
        // defer 없이 showModal로 직행 (아래 처리)
      } else {
        await btn.deferUpdate();
      }

      if (btn.customId.startsWith('plan_send_')) {
        // ✅ 전달
        try {
          const targetCh = await client.channels.fetch(agentInfo.channelId);
          await targetCh.send(`📋 **기획자 전달:** [report:${channel.id}]\n${task.message}`);
          await cardMsg.edit({
            embeds: [{ color: 0x22C55E, author: { name: `✅ 전달 완료` }, description: `${agentInfo.avatar} **${agentInfo.name}**에게 전달됨` }],
            components: [],
          });
          console.log(`📤 전달: ${task.agent} → ${task.message.slice(0, 80)}`);
          resolve('sent');
        } catch (err) {
          await cardMsg.edit({
            embeds: [{ color: 0xEF4444, author: { name: '❌ 전달 실패' }, description: err.message }],
            components: [],
          });
          resolve('error');
        }

      } else if (btn.customId.startsWith('plan_edit_')) {
        // ✏️ 수정 — Modal 팝업
        const modalId = `edit_modal_${taskId}`;
        const modal = new ModalBuilder()
          .setCustomId(modalId)
          .setTitle(`${agentInfo.name} 전달 내용 수정`);

        const textInput = new TextInputBuilder()
          .setCustomId('edited_message')
          .setLabel('전달 내용')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(task.message)
          .setRequired(true)
          .setMaxLength(2000);

        modal.addComponents(new ActionRowBuilder().addComponents(textInput));
        await btn.showModal(modal);

        // Modal 제출 대기
        try {
          const submission = await btn.awaitModalSubmit({ time: 300000 });
          const newContent = submission.fields.getTextInputValue('edited_message').trim();
          await submission.deferUpdate();

          const targetCh = await client.channels.fetch(agentInfo.channelId);
          await targetCh.send(`📋 **기획자 전달:** [report:${channel.id}]\n${newContent}`);
          await cardMsg.edit({
            embeds: [{ color: 0x22C55E, author: { name: '✅ 수정 후 전달 완료' }, description: `${agentInfo.avatar} **${agentInfo.name}**\n\n${newContent.length > 300 ? newContent.slice(0, 300) + '...' : newContent}` }],
            components: [],
          });
          console.log(`📤 수정 전달: ${task.agent} → ${newContent.slice(0, 80)}`);
          resolve('edited');
        } catch (err) {
          // Modal 타임아웃 or 에러
          await cardMsg.edit({
            embeds: [{ color: 0x6B7280, author: { name: '⏰ 수정 시간 초과' }, description: '전달이 취소되었습니다.' }],
            components: [],
          }).catch(() => {});
          resolve('timeout');
        }

      } else if (btn.customId.startsWith('plan_skip_')) {
        // ❌ 취소
        await cardMsg.edit({
          embeds: [{ color: 0x6B7280, author: { name: '❌ 취소됨' }, description: `${agentInfo.avatar} ${agentInfo.name} — 전달하지 않음` }],
          components: [],
        });
        resolve('skipped');
      }

      collector.stop();
    });

    collector.on('end', (collected) => {
      if (collected.size === 0) {
        cardMsg.edit({
          embeds: [{ color: 0x6B7280, author: { name: '⏰ 시간 초과' }, description: '5분 내 응답 없어 취소됨' }],
          components: [],
        }).catch(() => {});
        resolve('timeout');
      }
    });
  });
}

// ── 메시지 처리 ──
client.on('ready', () => {
  console.log(`🎯 기획자 봇 시작: ${client.user.tag} (PID: ${process.pid})`);
  console.log(`   기획 채널: ${PLANNER_CHANNELS.size}개, 에이전트: ${Object.keys(loadChannelMap()).length}개`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!PLANNER_CHANNELS.has(message.channel.id)) return;

  const content = message.content.trim();
  if (!content) return;

  if (content === '!reset' || content === '!새대화') {
    conversationHistory.delete(message.channel.id);
    await message.reply('🔄 대화가 초기화되었습니다.');
    return;
  }
  if (content === '!help') {
    const map = loadChannelMap();
    const list = Object.entries(map).map(([id, a]) => `${a.avatar} **${a.name}** → \`${id}\``).join('\n');
    await message.reply(`**🎯 기획자 봇**\n자연스럽게 대화하세요. 작업 전달 전 확인 카드가 표시됩니다.\n\n${list}\n\n\`!reset\` — 초기화`);
    return;
  }

  if (busyChannels.has(message.channel.id)) {
    // 큐에 추가
    if (!messageQueues.has(message.channel.id)) messageQueues.set(message.channel.id, []);
    const queue = messageQueues.get(message.channel.id);
    if (queue.length >= 5) {
      await message.reply('⚠️ 대기열이 가득 찼습니다 (최대 5개).');
      return;
    }
    queue.push({ message, content });
    await message.reply(`📥 메시지 접수 (${queue.length}번째) — 현재 작업 완료 후 처리합니다.`);
    return;
  }
  busyChannels.add(message.channel.id);

  const startTime = Date.now();
  const toolSteps = [];
  let progressMsg = null;
  let lastEditTime = 0;

  // 진행 임베드 + 타이핑
  try { progressMsg = await message.channel.send({ embeds: [makeProgressEmbed(startTime, toolSteps)] }); } catch {}
  const typingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 5000);
  message.channel.sendTyping().catch(() => {});
  const progressInterval = setInterval(async () => {
    if (!progressMsg || Date.now() - lastEditTime < 2500) return;
    lastEditTime = Date.now();
    try { await progressMsg.edit({ embeds: [makeProgressEmbed(startTime, toolSteps)] }); } catch {}
  }, 3000);

  try {
    addHistory(message.channel.id, '사용자', content);
    const systemPrompt = buildSystemPrompt() + getHistoryPrompt(message.channel.id);

    const onToolUse = (name, input) => {
      let detail = '';
      if (input?.file_path) detail = input.file_path.split('/').pop();
      else if (input?.pattern) detail = `"${input.pattern}"`;
      else if (input?.description) detail = input.description.slice(0, 50);
      toolSteps.push({ tool: name, detail });
      console.log(`  📊 [기획자] ${TOOL_ICONS[name] || '⚙️'} ${name}: ${detail}`);
    };

    const result = await callClaude(content, systemPrompt, onToolUse);
    clearInterval(typingInterval);
    clearInterval(progressInterval);

    if (!result.text) {
      console.error(`  ❌ [기획자] 빈 응답. prompt 길이=${content.length}, systemPrompt 길이=${systemPrompt.length}`);
      await message.reply('응답을 생성하지 못했습니다.');
      return;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const timeStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}분 ${elapsed % 60}초` : `${elapsed}초`;

    // JSON 파싱
    let parsed = null;
    try {
      const m = result.text.match(/\{[\s\S]*"tasks"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}

    if (parsed && parsed.tasks && parsed.tasks.length > 0) {
      // 진행 임베드 → 확인 대기
      if (progressMsg) {
        try { await progressMsg.edit({ embeds: [{
          color: 0x3B82F6, author: { name: '🎯 기획자 분석 완료' },
          description: `📋 ${parsed.tasks.length}개 작업 확인 카드를 표시합니다.`,
          footer: { text: `⏱️ ${timeStr} | 🔧 ${toolSteps.length}회 분석` },
        }] }); } catch {}
      }
      // 작업 전달 모드
      if (parsed.reply) await message.reply(parsed.reply);
      addHistory(message.channel.id, '기획자', parsed.reply || '작업 전달 준비');

      // 모든 카드를 동시에 전송, 각각 독립적으로 버튼 대기
      const channelMap = loadChannelMap();
      const promises = [];

      for (let i = 0; i < parsed.tasks.length; i++) {
        const task = parsed.tasks[i];
        const agentInfo = channelMap[task.agent];
        if (!agentInfo) {
          promises.push(Promise.resolve({ agent: task.agent, result: 'no_agent' }));
          continue;
        }
        promises.push(
          sendTaskCard(message.channel, task, agentInfo, i, parsed.tasks.length)
            .then(r => ({ agent: task.agent, name: agentInfo.name, avatar: agentInfo.avatar, result: r }))
        );
      }

      // 모든 카드의 응답을 기다림 (각각 독립적으로 5분 타임아웃)
      const settled = await Promise.all(promises);
      const lines = settled.map(s => {
        if (s.result === 'no_agent') return `❌ \`${s.agent}\` — 에이전트 없음`;
        const icon = s.result === 'sent' || s.result === 'edited' ? '✅' : s.result === 'skipped' ? '⏭️' : '⏰';
        const label = s.result === 'sent' ? '전달' : s.result === 'edited' ? '수정 전달' : s.result === 'skipped' ? '취소' : '시간초과';
        return `${icon} ${s.avatar} ${s.name} — ${label}`;
      });
      await message.channel.send(`**📊 최종 결과:**\n${lines.join('\n')}`);

    } else {
      // 일반 대화 — 진행 임베드 → 완료
      if (progressMsg) {
        try { await progressMsg.edit({ embeds: [{
          color: 0x22C55E, author: { name: '🎯 기획자 분석 완료' },
          description: toolSteps.length > 0 ? `✅ 코드 ${toolSteps.length}회 분석` : '✅ 응답 완료',
          footer: { text: `⏱️ ${timeStr}` },
        }] }); } catch {}
      }
      const clean = result.text.replace(/```json[\s\S]*?```/g, '').trim() || result.text;
      if (clean.length > 2000) {
        for (let i = 0; i < clean.length; i += 1990) await message.channel.send(clean.slice(i, i + 1990));
      } else {
        await message.reply(clean);
      }
      addHistory(message.channel.id, '기획자', clean.slice(0, 500));
    }

  } catch (err) {
    clearInterval(typingInterval);
    clearInterval(progressInterval);
    console.error('❌ 오류:', err.message);
    if (progressMsg) try { await progressMsg.edit({ embeds: [{ color: 0xEF4444, author: { name: '❌ 오류' }, description: err.message }] }); } catch {}
    await message.reply(`❌ ${err.message}`).catch(() => {});
  } finally {
    busyChannels.delete(message.channel.id);
    // 큐에 대기 중인 메시지 처리
    const queue = messageQueues.get(message.channel.id);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      setTimeout(() => {
        client.emit('messageCreate', next.message);
      }, 1000);
    }
  }
});

client.on('error', err => console.error('❌ Discord:', err.message));
client.login(TOKEN);
