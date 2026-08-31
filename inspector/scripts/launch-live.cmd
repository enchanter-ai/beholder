@echo off
rem One-command live session: spawns the real MCP filesystem server, runs
rem all 7 orchestrator phases through 9 plugins, streams bus events as JSONL
rem into the Rust cockpit — all behind a single `beholder live` invocation.

cd /d "%~dp0\..\..\"

if not exist "inspector\target\release\beholder.exe" (
    echo beholder.exe not built. Run: cd inspector ^&^& cargo build --release
    pause
    exit /b 1
)

inspector\target\release\beholder.exe live

echo.
pause
