#!/usr/bin/env python3
"""Real Codex persisted archive/unarchive/delete contract, isolated home; no model calls."""
import datetime
import json
import os
from pathlib import Path
import queue
import threading
import time
import uuid
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix="coc-real-management-") as directory:
    root = Path(directory)
    project = root / "project"
    project.mkdir()
    home = root / "codex-home"
    home.mkdir()
    marker = project / "keep.txt"
    marker.write_text("project files must survive", encoding="utf-8")
    environment = dict(os.environ, CODEX_HOME=str(home), COC_NO_STARTUP_REPAIR="1")
    process = subprocess.Popen(
        ["codex", "app-server", "--listen", "stdio://"],
        cwd=project, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, bufsize=1,
    )
    responses = queue.Queue()

    def read_responses():
        for line in process.stdout:
            responses.put(json.loads(line))
        responses.put(None)

    threading.Thread(target=read_responses, daemon=True).start()
    counter = 0

    def rpc(method, params):
        global counter
        counter += 1
        process.stdin.write(json.dumps({"id": counter, "method": method, "params": params}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                response = responses.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise AssertionError("Codex timed out during " + method) from None
            assert response is not None, "Codex exited during " + method
            if response.get("id") == counter:
                assert "result" in response, (method, response)
                return response["result"]
        raise AssertionError("Codex timed out during " + method)

    kinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
             "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"]

    def catalog(archived):
        return rpc("thread/list", {"limit": 100, "archived": archived, "sourceKinds": kinds, "modelProviders": []})["data"]

    try:
        rpc("initialize", {"clientInfo": {"name": "coc-isolated-management-test", "version": "1"}})
        process.stdin.write('{"method":"initialized"}\n')
        process.stdin.flush()
        bootstrap = rpc("thread/start", {
            "cwd": str(project), "ephemeral": False,
            "approvalPolicy": "never", "sandbox": "read-only",
        })["thread"]
        bootstrap_id = bootstrap["id"]
        # Materialize a valid empty rollout without making a model request.
        rpc("thread/archive", {"threadId": bootstrap_id})
        archived = next(row for row in catalog(True) if row["id"] == bootstrap_id)
        template = Path(archived["path"]).read_text(encoding="utf-8")
        rpc("thread/delete", {"threadId": bootstrap_id})
        user_item = json.dumps({
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "type": "event_msg",
            "payload": {
                "type": "user_message", "message": "Synthetic archive contract test",
                "images": [], "local_images": [], "text_elements": [],
            },
        }) + "\n"
        # Seed two ordinary persisted conversations entirely in our temporary
        # home, then let the public list API index them. Never edit Codex's DB.
        active_directory = home / "sessions" / datetime.datetime.now().strftime("%Y/%m/%d")
        active_directory.mkdir(parents=True, exist_ok=True)
        thread_id, other_id = str(uuid.uuid4()), str(uuid.uuid4())
        for identity, provider in ((thread_id, "openai"), (other_id, "other")):
            path = active_directory / Path(archived["path"]).name.replace(bootstrap_id, identity)
            text = template.replace(bootstrap_id, identity).replace(
                '\"model_provider\":\"openai\"', '\"model_provider\":' + json.dumps(provider))
            path.write_text(text + user_item, encoding="utf-8")
            assert any(row["id"] == identity for row in rpc(
                "thread/list", {"limit": 100, "modelProviders": [provider], "sourceKinds": kinds},
            )["data"])
        assert {thread_id, other_id}.issubset({row["id"] for row in catalog(False)})
        active_path = next(Path(row["path"]) for row in catalog(False) if row["id"] == thread_id)
        rpc("thread/archive", {"threadId": thread_id})
        archived_path = next(Path(row["path"]) for row in catalog(True) if row["id"] == thread_id)
        assert archived_path.is_file() and not active_path.exists()
        assert "archived_sessions" in archived_path.parts
        restored = rpc("thread/unarchive", {"threadId": thread_id})["thread"]
        active_path = Path(restored["path"])
        assert active_path.is_file() and not archived_path.exists()
        assert any(row["id"] == thread_id for row in catalog(False))
        rpc("thread/delete", {"threadId": thread_id})
        assert not active_path.exists()
        assert all(row["id"] != thread_id for row in catalog(False) + catalog(True))
        assert any(row["id"] == other_id for row in catalog(False))
        rpc("thread/delete", {"threadId": other_id})
        assert marker.read_text(encoding="utf-8") == "project files must survive"
        print("PASS: real Codex archive moves JSONL, unarchive restores it, delete removes JSONL/catalog; project files preserved; no model calls")
    finally:
        process.terminate()
        process.wait(timeout=10)
