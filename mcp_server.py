#!/usr/bin/env python3
"""Discord MCP Server — Claude Code에서 Discord 채널 읽기/쓰기 도구 제공.

Discord REST API를 직접 호출하여 Node.js 봇과 충돌 없이 동작.
stdio 기반 MCP 프로토콜.
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import requests
from mcp.server import Server
from mcp.server.stdio import stdio_server
import mcp.types as types

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# Discord Bot Token
DISCORD_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
if not DISCORD_TOKEN:
    # .env 파일에서 로드 시도
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("DISCORD_TOKEN="):
                DISCORD_TOKEN = line.split("=", 1)[1].strip()
                break

BASE_URL = "https://discord.com/api/v10"
HEADERS = {
    "Authorization": f"Bot {DISCORD_TOKEN}",
    "Content-Type": "application/json",
}

# 기본 길드 ID (config.json에서 로드)
DEFAULT_GUILD_ID = ""
CONFIG_PATH = Path(__file__).parent / "config.json"

def load_guild_id():
    """config.json의 channelBindings에서 길드 ID를 자동 감지."""
    global DEFAULT_GUILD_ID
    if CONFIG_PATH.exists():
        config = json.loads(CONFIG_PATH.read_text())
        bindings = config.get("channelBindings", {})
        if bindings:
            # 첫 번째 채널에서 길드 ID 조회
            first_channel_id = list(bindings.keys())[0]
            try:
                resp = requests.get(
                    f"{BASE_URL}/channels/{first_channel_id}",
                    headers=HEADERS,
                    timeout=10,
                )
                if resp.status_code == 200:
                    DEFAULT_GUILD_ID = resp.json().get("guild_id", "")
                    log.info("길드 ID 감지: %s", DEFAULT_GUILD_ID)
            except Exception as e:
                log.warning("길드 ID 감지 실패: %s", e)


# ─────────────────────────────────────────
#  Discord REST API 래퍼
# ─────────────────────────────────────────

def discord_list_channels(guild_id: str = "") -> list[dict]:
    """서버의 채널 목록 조회."""
    gid = guild_id or DEFAULT_GUILD_ID
    if not gid:
        return [{"error": "guild_id가 필요합니다"}]

    resp = requests.get(f"{BASE_URL}/guilds/{gid}/channels", headers=HEADERS, timeout=15)
    if resp.status_code != 200:
        return [{"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}]

    channels = resp.json()
    # 텍스트 채널만 필터링, 정리
    result = []
    for ch in channels:
        if ch.get("type") in (0, 5):  # GUILD_TEXT, GUILD_ANNOUNCEMENT
            result.append({
                "id": ch["id"],
                "name": ch.get("name", ""),
                "topic": ch.get("topic", ""),
                "parent_id": ch.get("parent_id", ""),
            })
    return sorted(result, key=lambda c: c["name"])


def discord_read_messages(channel_id: str, count: int = 10) -> list[dict]:
    """채널의 최근 메시지 읽기."""
    count = min(count, 50)
    resp = requests.get(
        f"{BASE_URL}/channels/{channel_id}/messages",
        headers=HEADERS,
        params={"limit": count},
        timeout=15,
    )
    if resp.status_code != 200:
        return [{"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}]

    messages = resp.json()
    result = []
    for msg in messages:
        attachments = []
        for att in msg.get("attachments", []):
            attachments.append({
                "filename": att.get("filename", ""),
                "url": att.get("url", ""),
                "size": att.get("size", 0),
                "content_type": att.get("content_type", ""),
            })

        result.append({
            "id": msg["id"],
            "author": msg.get("author", {}).get("username", "unknown"),
            "content": msg.get("content", ""),
            "timestamp": msg.get("timestamp", ""),
            "attachments": attachments,
        })
    return result


def discord_send_message(channel_id: str, content: str) -> dict:
    """채널에 텍스트 메시지 전송."""
    # Discord 메시지 길이 제한 (2000자)
    if len(content) > 2000:
        # 분할 전송
        parts = []
        remaining = content
        while remaining:
            if len(remaining) <= 2000:
                parts.append(remaining)
                break
            idx = remaining.rfind("\n", 0, 2000)
            if idx == -1 or idx < 1000:
                idx = 2000
            parts.append(remaining[:idx])
            remaining = remaining[idx:].lstrip()

        results = []
        for part in parts:
            resp = requests.post(
                f"{BASE_URL}/channels/{channel_id}/messages",
                headers=HEADERS,
                json={"content": part},
                timeout=15,
            )
            results.append(resp.status_code)

        return {"status": "sent", "parts": len(parts), "statuses": results}

    resp = requests.post(
        f"{BASE_URL}/channels/{channel_id}/messages",
        headers=HEADERS,
        json={"content": content},
        timeout=15,
    )
    if resp.status_code in (200, 201):
        data = resp.json()
        return {"status": "sent", "message_id": data.get("id", "")}
    return {"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}


def discord_send_file(channel_id: str, file_path: str, message: str = "") -> dict:
    """채널에 파일 첨부 전송."""
    fpath = Path(file_path)
    if not fpath.exists():
        return {"error": f"파일 없음: {file_path}"}

    # multipart/form-data 전송
    headers = {"Authorization": f"Bot {DISCORD_TOKEN}"}
    files_data = {"file": (fpath.name, fpath.open("rb"))}
    payload = {}
    if message:
        payload["content"] = message

    resp = requests.post(
        f"{BASE_URL}/channels/{channel_id}/messages",
        headers=headers,
        data=payload,
        files=files_data,
        timeout=30,
    )
    if resp.status_code in (200, 201):
        data = resp.json()
        return {"status": "sent", "message_id": data.get("id", ""), "filename": fpath.name}
    return {"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}


# ─────────────────────────────────────────
#  MCP Server 정의
# ─────────────────────────────────────────

server = Server("discord")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="discord_list_channels",
            description="Discord 서버의 텍스트 채널 목록을 조회합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "guild_id": {
                        "type": "string",
                        "description": "서버(길드) ID. 비워두면 기본 서버 사용.",
                    },
                },
            },
        ),
        types.Tool(
            name="discord_read_messages",
            description="Discord 채널의 최근 메시지를 읽습니다. 첨부파일 URL도 포함됩니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "channel_id": {
                        "type": "string",
                        "description": "채널 ID",
                    },
                    "count": {
                        "type": "integer",
                        "description": "읽을 메시지 수 (기본 10, 최대 50)",
                        "default": 10,
                    },
                },
                "required": ["channel_id"],
            },
        ),
        types.Tool(
            name="discord_send_message",
            description="Discord 채널에 텍스트 메시지를 전송합니다. 2000자 초과 시 자동 분할.",
            inputSchema={
                "type": "object",
                "properties": {
                    "channel_id": {
                        "type": "string",
                        "description": "채널 ID",
                    },
                    "content": {
                        "type": "string",
                        "description": "전송할 메시지 내용",
                    },
                },
                "required": ["channel_id", "content"],
            },
        ),
        types.Tool(
            name="discord_send_file",
            description="Discord 채널에 파일을 첨부하여 전송합니다.",
            inputSchema={
                "type": "object",
                "properties": {
                    "channel_id": {
                        "type": "string",
                        "description": "채널 ID",
                    },
                    "file_path": {
                        "type": "string",
                        "description": "전송할 파일의 절대 경로",
                    },
                    "message": {
                        "type": "string",
                        "description": "파일과 함께 보낼 메시지 (선택사항)",
                        "default": "",
                    },
                },
                "required": ["channel_id", "file_path"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    try:
        if name == "discord_list_channels":
            result = discord_list_channels(arguments.get("guild_id", ""))
        elif name == "discord_read_messages":
            result = discord_read_messages(
                arguments["channel_id"],
                arguments.get("count", 10),
            )
        elif name == "discord_send_message":
            result = discord_send_message(
                arguments["channel_id"],
                arguments["content"],
            )
        elif name == "discord_send_file":
            result = discord_send_file(
                arguments["channel_id"],
                arguments["file_path"],
                arguments.get("message", ""),
            )
        else:
            result = {"error": f"알 수 없는 도구: {name}"}

        return [types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]

    except Exception as e:
        log.error("도구 실행 오류 (%s): %s", name, e)
        return [types.TextContent(type="text", text=json.dumps({"error": str(e)}, ensure_ascii=False))]


# ─────────────────────────────────────────
#  메인 실행
# ─────────────────────────────────────────

async def main():
    load_guild_id()
    log.info("Discord MCP Server 시작")
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
