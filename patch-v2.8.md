# 🔧 Claude Bot v2.8 패치 가이드

## 변경사항 (v2.5 → v2.8)

### 🛡️ 봇 프로세스 보호
- `--disallowedTools`로 kill/pkill/pgrep/killall/launchctl **CLI 레벨 차단**
- Claude가 봇 프로세스를 종료하는 문제 완전 해결

### 🔑 OAuth 인증 안정화
- Claude CLI가 자체적으로 키체인에서 토큰 읽고 refresh하도록 변경
- 만료 토큰 주입 문제 해결
- `findClaudeBin()` 자동 탐지 (launchctl PATH 문제 해결)

### 📊 프로젝트별 대시보드
- `📊-대시보드` 채널 자동 생성 (프로젝트별)
- 5초 간격 실시간 업데이트
- 작업중 애니메이션 (작업중. → 작업중.. → 작업중...)
- 대시보드 채널 사용자 메시지 자동 삭제
- 24시간 작업 통계

### 📥 메시지 큐 시스템
- 채널별 최대 5개 대기열
- `!stop`/`!중지`로 현재 작업 중단
- `!queue`/`!대기열`로 대기열 확인

### 🤖 응답 개선
- 빈 응답 시 자동 후속 호출 (최대 2회)
- 시스템 프롬프트에 행동 규칙 강화
- 기본 모델: Opus 4.6

---

## 패치 방법

### 방법 1: bot.js 교체 (가장 간단)
1. 봇 중지: `launchctl bootout gui/$(id -u)/com.claude-discord.bot`
2. 첨부된 `bot-v2.8.js`를 `bot.js`로 이름 변경
3. 기존 `bot.js`를 교체 (경로: `~/claude-discord-bot/bot.js`)
4. 봇 시작: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.discord.bot.plist`

### 방법 2: 클로드에게 시키기
하이브마인드 채널에 아래 메시지를 전송:
```
첨부된 bot-v2.8.js 파일로 현재 bot.js를 교체해줘.
교체 후 봇을 재시작해.
경로: ~/claude-discord-bot/bot.js
```

---

## 주의사항
- config.json, .env, sessions.json은 건드리지 않음 (설정 유지)
- node_modules도 그대로 사용 가능 (새 의존성 없음)
