#!/usr/bin/env python3
"""
Core Bot — 시스템 최고 관리자 봇
절대 수정하지 말 것 — 에이전트 접근 금지
"""

import discord
import asyncio
import subprocess
import os
import signal
import time
import shlex

TOKEN = os.environ.get("CORE_BOT_TOKEN", "")
ALLOWED_CHANNEL_STR = "1486725645856800828"  # 이 채널에서만 명령 수신 (항상 문자열 비교)

SERVICES = {
    "claude": {
        "label": "com.claude.discord.bot",
        "plist": os.path.expanduser("~/Library/LaunchAgents/com.claude.discord.bot.plist"),
        "log": os.path.expanduser("~/Library/Logs/claude-discord-bot.log"),
        "name": "ClaudCode Overmind (bot.js)",
        "pgrep": "node.*bot.js",
    },
    "overmind": {
        "label": "com.overmind.bot",
        "plist": os.path.expanduser("~/Library/LaunchAgents/com.overmind.bot.plist"),
        "log": os.path.expanduser("~/Library/Logs/overmind/bot.stdout.log"),
        "name": "Proj.Overmind (bot.py)",
        "pgrep": "projovermind.*bot.py",
    },
    "core": {
        "label": "com.guardian.bot",
        "plist": os.path.expanduser("~/Library/LaunchAgents/com.guardian.bot.plist"),
        "log": os.path.expanduser("~/Library/Logs/guardian-bot.log"),
        "name": "Core Bot (core.py)",
        "pgrep": "core.py",
    },
}

HELP_TEXT = """**⚙️ Core Bot 명령어**
`!run <명령>` — 쉘 명령 실행
`!restart claude/overmind/all` — 서비스 재시작
`!status` — 전체 상태 확인
`!ps [검색어]` — 프로세스 목록
`!kill <PID>` — 프로세스 종료 (SIGTERM)
`!kill9 <PID>` — 프로세스 강제종료 (SIGKILL)
`!logs claude/overmind/core [줄수]` — 로그 확인
`!open <URL 또는 앱>` — 브라우저/앱 열기
`!read <파일경로>` — 파일 읽기
`!launchctl <명령>` — launchctl 직접 실행
`!help` — 이 도움말"""


intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)


def get_pid(service_key):
    try:
        pgrep_pattern = SERVICES[service_key]["pgrep"]
        result = subprocess.run(
            ["pgrep", "-f", pgrep_pattern],
            capture_output=True, text=True
        )
        pids = [p for p in result.stdout.strip().splitlines() if int(p) != os.getpid()]
        return int(pids[0]) if pids else None
    except Exception:
        return None


def run_shell(cmd, timeout=30):
    """쉘 명령 실행 후 출력 반환"""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            timeout=timeout,
            env={**os.environ, "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
        )
        out = result.stdout.strip()
        err = result.stderr.strip()
        combined = ""
        if out:
            combined += out
        if err:
            combined += ("\n" if combined else "") + f"[stderr] {err}"
        return combined or "(출력 없음)", result.returncode
    except subprocess.TimeoutExpired:
        return "⏰ 타임아웃 (30초)", -1
    except Exception as e:
        return f"❌ 오류: {e}", -1


def restart_service(service_key):
    svc = SERVICES[service_key]
    label = svc["label"]
    try:
        pid = get_pid(service_key)
        if pid:
            os.kill(pid, signal.SIGTERM)
            time.sleep(1)

        subprocess.run(["launchctl", "stop", label], capture_output=True)
        time.sleep(1)
        result = subprocess.run(["launchctl", "start", label], capture_output=True, text=True)
        if result.returncode != 0:
            subprocess.run(["launchctl", "load", "-w", svc["plist"]], capture_output=True)
            subprocess.run(["launchctl", "start", label], capture_output=True)

        time.sleep(2)
        new_pid = get_pid(service_key)
        if new_pid:
            return True, f"✅ `{svc['name']}` 재시작 완료 (PID: {new_pid})"
        else:
            return False, f"⚠️ `{svc['name']}` 재시작 명령 전송됨"
    except Exception as e:
        return False, f"❌ 재시작 실패: {e}"


def get_status():
    lines = ["**⚙️ Core Bot — 서비스 상태**", ""]
    for key, svc in SERVICES.items():
        pid = get_pid(key)
        if pid:
            ps = subprocess.run(
                ["ps", "-p", str(pid), "-o", "pid=,etime=,%cpu=,%mem="],
                capture_output=True, text=True
            )
            info = ps.stdout.strip()
            lines.append(f"🟢 **{svc['name']}** — PID `{pid}`  `{info}`")
        else:
            lines.append(f"🔴 **{svc['name']}** — 실행 중 아님")
    lines.append("")
    lines.append(f"⚙️ **Core Bot** — PID `{os.getpid()}`")
    return "\n".join(lines)


def get_logs(service_key, n=20):
    svc = SERVICES.get(service_key)
    if not svc:
        return "❌ 알 수 없는 서비스"
    try:
        result = subprocess.run(["tail", f"-{n}", svc["log"]], capture_output=True, text=True)
        content = result.stdout.strip() or "(로그 없음)"
        if len(content) > 1800:
            content = "..." + content[-1800:]
        return f"**{svc['name']} 최근 {n}줄:**\n```\n{content}\n```"
    except Exception as e:
        return f"❌ 로그 읽기 실패: {e}"


async def send_long(channel, text, code_block=False):
    """2000자 넘으면 분할 전송"""
    if code_block:
        text = f"```\n{text}\n```"
    chunks = [text[i:i+1990] for i in range(0, len(text), 1990)]
    for chunk in chunks:
        await channel.send(chunk)


@client.event
async def on_ready():
    print(f"⚙️ Core Bot 시작: {client.user} (PID: {os.getpid()})", flush=True)


@client.event
async def on_message(message):
    if message.author.bot:
        return
    ch = str(message.channel.id)
    # 디버그: 모든 메시지 채널 로깅
    print(f"📨 msg ch={ch} allowed={ALLOWED_CHANNEL_STR} match={ch == ALLOWED_CHANNEL_STR} author={message.author} content={message.content[:30]}", flush=True)
    if ch != ALLOWED_CHANNEL_STR:
        return

    content = message.content.strip()
    if not content.startswith("!"):
        return

    # 첫 번째 단어가 명령어, 나머지가 인자
    first_space = content.find(" ")
    if first_space == -1:
        cmd = content.lower()
        args_raw = ""
    else:
        cmd = content[:first_space].lower()
        args_raw = content[first_space+1:].strip()

    parts = content.split()

    # ── !help ──────────────────────────────
    if cmd == "!help":
        await message.channel.send(HELP_TEXT)

    # ── !run / !bash ────────────────────────
    elif cmd in ("!run", "!bash", "!sh"):
        if not args_raw:
            await message.channel.send("사용법: `!run <명령>`")
            return
        await message.channel.send(f"⚙️ 실행 중: `{args_raw[:100]}`")
        output, code = await asyncio.get_event_loop().run_in_executor(
            None, run_shell, args_raw
        )
        prefix = f"✅ (exit {code})\n" if code == 0 else f"⚠️ (exit {code})\n"
        await send_long(message.channel, prefix + output)

    # ── !launchctl ──────────────────────────
    elif cmd == "!launchctl":
        if not args_raw:
            await message.channel.send("사용법: `!launchctl <명령>` (예: `!launchctl list`)")
            return
        output, code = await asyncio.get_event_loop().run_in_executor(
            None, run_shell, f"launchctl {args_raw}"
        )
        await send_long(message.channel, output or "(출력 없음)")

    # ── !restart ────────────────────────────
    elif cmd == "!restart":
        target = parts[1].lower() if len(parts) > 1 else ""
        if target in ("all", "전체"):
            await message.channel.send("🔄 전체 재시작 중...")
            results = []
            for key in ("claude", "overmind"):
                ok, msg = await asyncio.get_event_loop().run_in_executor(None, restart_service, key)
                results.append(msg)
                await asyncio.sleep(1)
            await message.channel.send("\n".join(results))
        elif target in SERVICES:
            await message.channel.send(f"🔄 `{SERVICES[target]['name']}` 재시작 중...")
            ok, msg = await asyncio.get_event_loop().run_in_executor(None, restart_service, target)
            await message.channel.send(msg)
        else:
            await message.channel.send("사용법: `!restart claude` / `!restart overmind` / `!restart all`")

    # ── !status ─────────────────────────────
    elif cmd == "!status":
        await message.channel.send(get_status())

    # ── !ps ─────────────────────────────────
    elif cmd == "!ps":
        filter_str = args_raw or ""
        if filter_str:
            output, _ = await asyncio.get_event_loop().run_in_executor(
                None, run_shell, f"ps aux | grep -i '{filter_str}' | grep -v grep"
            )
        else:
            output, _ = await asyncio.get_event_loop().run_in_executor(
                None, run_shell, "ps aux | head -30"
            )
        await send_long(message.channel, output)

    # ── !kill / !kill9 ───────────────────────
    elif cmd in ("!kill", "!kill9"):
        if len(parts) < 2:
            await message.channel.send(f"사용법: `{cmd} <PID>`")
            return
        try:
            pid = int(parts[1])
            if pid in (1, os.getpid()):
                await message.channel.send("❌ 이 프로세스는 종료할 수 없습니다.")
                return
            sig = signal.SIGKILL if cmd == "!kill9" else signal.SIGTERM
            os.kill(pid, sig)
            await message.channel.send(f"✅ PID `{pid}`에 {'SIGKILL' if cmd == '!kill9' else 'SIGTERM'} 전송")
        except ProcessLookupError:
            await message.channel.send(f"❌ PID `{parts[1]}` 없음")
        except (ValueError, PermissionError) as e:
            await message.channel.send(f"❌ {e}")

    # ── !logs ────────────────────────────────
    elif cmd == "!logs":
        target = parts[1].lower() if len(parts) > 1 else ""
        n = 20
        if len(parts) > 2:
            try:
                n = min(int(parts[2]), 100)
            except ValueError:
                pass
        if target in SERVICES:
            await send_long(message.channel, get_logs(target, n))
        else:
            await message.channel.send("사용법: `!logs claude/overmind/core [줄수]`")

    # ── !open ────────────────────────────────
    elif cmd == "!open":
        if not args_raw:
            await message.channel.send("사용법: `!open <URL 또는 앱 이름>`")
            return
        output, code = await asyncio.get_event_loop().run_in_executor(
            None, run_shell, f"open {shlex.quote(args_raw)}"
        )
        await message.channel.send(f"✅ 열기 완료: `{args_raw}`" if code == 0 else f"❌ {output}")

    # ── !read ────────────────────────────────
    elif cmd == "!read":
        if not args_raw:
            await message.channel.send("사용법: `!read <파일경로>`")
            return
        path = os.path.expanduser(args_raw)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content_text = f.read(3000)
            if len(content_text) == 3000:
                content_text += "\n...(잘림)"
            await send_long(message.channel, f"📄 `{path}`:\n{content_text}")
        except Exception as e:
            await message.channel.send(f"❌ 읽기 실패: {e}")


if __name__ == "__main__":
    client.run(TOKEN)
