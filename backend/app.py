from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Literal, Optional, Dict, Any

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from openai import OpenAI

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("agentbuilder")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

BASE_AGENT_TEMPLATE = """
import os
from typing import List, Dict

from openai import OpenAI

class Agent:
    def __init__(self, tools: List[str]):
        self.tools = tools
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    def plan(self, task: str) -> List[Dict[str, str]]:
        return [
            {"step": "analyze", "detail": task},
            {"step": "select_tool", "detail": ", ".join(self.tools)},
            {"step": "execute", "detail": "run selected tools"},
            {"step": "summarize", "detail": "return result"},
        ]

    def call_llm(self, prompt: str) -> str:
        # Placeholder LLM call for the agent pipeline
        resp = self.client.responses.create(
            model="gpt-5-nano-2025-08-07",
            input=[{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
        )
        return resp.output_text

    def run(self, task: str) -> str:
        plan = self.plan(task)
        _ = self.call_llm(task)
        return "\\n".join([f"{p['step']}: {p['detail']}" for p in plan])

if __name__ == "__main__":
    agent = Agent(["search", "codegen", "diagram"])
    print(agent.run("Build a simple agent"))
""".strip()

PLANNER_PROMPT = """
You are the planning assistant for an agent-building system.
Return a strict JSON object with keys:
- assistant_text: short response to the user
- plan: 3-6 bullet points describing the intended agent design and changes

Rules:
- Output must be JSON only (no markdown, no extra text).
- Keep the plan concise and technical.
- Treat data ingestion and preprocessing as a blackbox step named "Ingestion + Preprocess".
- Do not enumerate data sources or ETL details; assume "processed_text" is provided to the LLM.
- Focus only on agent architecture and prompts, not implementation details.
- Make assistant_text friendly, professional, and conversational (1-3 sentences).
""".strip()

DIAGRAM_PROMPT = """
You are the diagram assistant. Generate a Mermaid flowchart for the agent plan.
Return a strict JSON object with keys:
- diagram_mermaid: a Mermaid flowchart showing agent building blocks

Rules:
- Output must be JSON only (no markdown, no extra text).
- Use Mermaid flowchart syntax like: flowchart LR\n  A[Input] --> B[Planner]
- Include a single blackbox node labeled "Ingestion + Preprocess" and do not expand it.
- Keep node labels short (no colons, no long sentences).
- Prefer 6-8 nodes maximum.
""".strip()

CODE_PROMPT = f"""
You are the code assistant. Generate updated Python agent code from the plan.
Return a strict JSON object with keys:
- agent_code: updated Python code based on the base template

Rules:
- Output must be JSON only (no markdown, no extra text).
- Keep agent_code valid Python.
- Modify the base template as needed, but keep it simple and architecture-focused.
- No external libraries or data ingestion logic.
- Include placeholder functions only (no actual plotting or parsing).
- Add a placeholder function `ingest_and_preprocess(text: str) -> str` and call it before the LLM.
- Include an OpenAI Responses API call (like the base template) as the core LLM step.
- The code must define `class Agent` with `run(self, task: str) -> str` so it can be executed by the runner.

Base template (for reference):
{BASE_AGENT_TEMPLATE}
""".strip()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]


class ChatResponse(BaseModel):
    assistant_text: str
    diagram_mermaid: str
    agent_code: str
    raw_text: Optional[str] = None


class RunRequest(BaseModel):
    agent_code: str
    prompt: str
    tools: Optional[List[str]] = None


class RunResponse(BaseModel):
    ok: bool
    stdout: str
    stderr: str
    exit_code: int


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


def _extract_json(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def _content_type_for_role(role: str) -> str:
    if role == "assistant":
        return "output_text"
    return "input_text"


def _responses_call(
    system_prompt: str,
    messages: List[ChatMessage],
    response_format: Dict[str, Any],
) -> str:
    input_messages = [
        {
            "role": "system",
            "content": [{"type": "input_text", "text": system_prompt}],
        }
    ]

    for msg in messages:
        input_messages.append(
            {
                "role": msg.role,
                "content": [
                    {"type": _content_type_for_role(msg.role), "text": msg.content}
                ],
            }
        )

    try:
        resp = client.responses.create(
            model="gpt-5-nano-2025-08-07",
            input=input_messages,
            text={
                "format": response_format
            },
            reasoning={"effort": "medium"},
        )
        return resp.output_text
    except Exception as exc:
        logger.exception("OpenAI call failed: %s", exc)
        raise


def _responses_stream(
    system_prompt: str,
    messages: List[ChatMessage],
    response_format: Dict[str, Any],
):
    input_messages = [
        {
            "role": "system",
            "content": [{"type": "input_text", "text": system_prompt}],
        }
    ]

    for msg in messages:
        input_messages.append(
            {
                "role": msg.role,
                "content": [
                    {"type": _content_type_for_role(msg.role), "text": msg.content}
                ],
            }
        )

    return client.responses.create(
        model="gpt-5-nano-2025-08-07",
        input=input_messages,
        text={
            "format": response_format
        },
        reasoning={"effort": "medium"},
        stream=True,
    )


def _run_agent_code(agent_code: str, prompt: str, tools: Optional[List[str]]) -> RunResponse:
    if len(agent_code) > 120_000:
        return RunResponse(
            ok=False,
            stdout="",
            stderr="Agent code too large. Limit is 120k characters.",
            exit_code=1,
        )
    if not re.search(r"class\s+Agent\b", agent_code):
        return RunResponse(
            ok=False,
            stdout="",
            stderr="Agent code must define class Agent for the runner.",
            exit_code=1,
        )
    if not re.search(r"def\s+run\s*\(\s*self\s*,\s*task\s*:\s*str\s*\)\s*->\s*str\s*:", agent_code):
        return RunResponse(
            ok=False,
            stdout="",
            stderr="Agent code must define run(self, task: str) -> str for the runner.",
            exit_code=1,
        )

    runner_source = """import json
import sys
from agent import Agent

def main():
    payload = json.loads(sys.stdin.read() or "{}")
    prompt = payload.get("prompt", "")
    tools = payload.get("tools") or ["search", "codegen", "diagram"]
    agent = Agent(tools)
    out = agent.run(prompt)
    if out is None:
        out = ""
    sys.stdout.write(str(out))

if __name__ == "__main__":
    main()
"""

    with tempfile.TemporaryDirectory() as tmpdir:
        agent_path = Path(tmpdir) / "agent.py"
        runner_path = Path(tmpdir) / "runner.py"
        agent_path.write_text(agent_code, encoding="utf-8")
        runner_path.write_text(runner_source, encoding="utf-8")

        payload = json.dumps({"prompt": prompt, "tools": tools or []})
        try:
            proc = subprocess.run(
                [sys.executable, str(runner_path)],
                input=payload.encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
                cwd=tmpdir,
                env={**os.environ},
            )
            return RunResponse(
                ok=proc.returncode == 0,
                stdout=proc.stdout.decode("utf-8", errors="replace"),
                stderr=proc.stderr.decode("utf-8", errors="replace"),
                exit_code=proc.returncode,
            )
        except subprocess.TimeoutExpired as exc:
            return RunResponse(
                ok=False,
                stdout=(exc.stdout or b"").decode("utf-8", errors="replace"),
                stderr="Execution timed out after 60 seconds.",
                exit_code=124,
            )
        except Exception as exc:
            return RunResponse(
                ok=False,
                stdout="",
                stderr=f"Runner failed: {exc}",
                exit_code=1,
            )


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    try:
        processed_text = " ".join(
            [msg.content.strip() for msg in req.messages if msg.role == "user"]
        ).strip()
        if processed_text:
            processed_note = ChatMessage(
                role="user",
                content=f"Processed text (from Ingestion + Preprocess):\n{processed_text}",
            )
        else:
            processed_note = None

        planner_format = {
            "type": "json_schema",
            "name": "agent_plan",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "assistant_text": {"type": "string"},
                    "plan": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["assistant_text", "plan"],
                "additionalProperties": False,
            },
        }
        diagram_format = {
            "type": "json_schema",
            "name": "agent_diagram",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {"diagram_mermaid": {"type": "string"}},
                "required": ["diagram_mermaid"],
                "additionalProperties": False,
            },
        }
        code_format = {
            "type": "json_schema",
            "name": "agent_code",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {"agent_code": {"type": "string"}},
                "required": ["agent_code"],
                "additionalProperties": False,
            },
        }

        planner_messages = req.messages + ([processed_note] if processed_note else [])
        planner_text = _responses_call(PLANNER_PROMPT, planner_messages, planner_format)
        logger.info("Planner raw: %s", planner_text[:2000])
        planner_data = _extract_json(planner_text)
        assistant_text = planner_data.get("assistant_text", "")
        plan = planner_data.get("plan", [])

        diagram_context = planner_messages + [
            ChatMessage(
                role="user",
                content=f"Plan:\n- " + "\n- ".join(plan)
                if isinstance(plan, list)
                else f"Plan:\n{plan}",
            )
        ]
        diagram_text = _responses_call(DIAGRAM_PROMPT, diagram_context, diagram_format)
        logger.info("Diagram raw: %s", diagram_text[:2000])
        diagram_data = _extract_json(diagram_text)
        diagram_mermaid = diagram_data.get("diagram_mermaid", "")

        code_context = diagram_context + [
            ChatMessage(role="user", content=f"Diagram:\n{diagram_mermaid}")
        ]
        code_text = _responses_call(CODE_PROMPT, code_context, code_format)
        logger.info("Code raw: %s", code_text[:2000])
        code_data = _extract_json(code_text)
        agent_code = code_data.get("agent_code", "")

        return ChatResponse(
            assistant_text=assistant_text,
            diagram_mermaid=diagram_mermaid,
            agent_code=agent_code,
        )
    except Exception as exc:
        logger.exception("Chat handler failed: %s", exc)
        return ChatResponse(
            assistant_text="I had trouble formatting the response. Try again.",
            diagram_mermaid="flowchart LR\n  A[Input] --> B[Planner] --> C[Tools] --> D[Output]",
            agent_code=BASE_AGENT_TEMPLATE,
            raw_text=str(exc),
        )


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest):
    def event_stream():
        try:
            processed_text = " ".join(
                [msg.content.strip() for msg in req.messages if msg.role == "user"]
            ).strip()
            if processed_text:
                processed_note = ChatMessage(
                    role="user",
                    content=f"Processed text (from Ingestion + Preprocess):\n{processed_text}",
                )
            else:
                processed_note = None

            planner_format = {
                "type": "json_schema",
                "name": "agent_plan",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "assistant_text": {"type": "string"},
                        "plan": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["assistant_text", "plan"],
                    "additionalProperties": False,
                },
            }
            diagram_format = {
                "type": "json_schema",
                "name": "agent_diagram",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {"diagram_mermaid": {"type": "string"}},
                    "required": ["diagram_mermaid"],
                    "additionalProperties": False,
                },
            }
            code_format = {
                "type": "json_schema",
                "name": "agent_code",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {"agent_code": {"type": "string"}},
                    "required": ["agent_code"],
                    "additionalProperties": False,
                },
            }

            def send(data: dict, event_name: str = "message"):
                return f"event: {event_name}\n" f"data: {json.dumps(data)}\n\n"

            planner_messages = req.messages + ([processed_note] if processed_note else [])
            yield send({"phase": "planner", "type": "phase.start", "status": "Planning response"})
            planner_buffer = []
            for event in _responses_stream(PLANNER_PROMPT, planner_messages, planner_format):
                payload = {
                    "phase": "planner",
                    "type": getattr(event, "type", "unknown"),
                    "delta": getattr(event, "delta", None),
                }
                yield send(payload)
                if getattr(event, "type", "") == "response.output_text.delta":
                    if event.delta:
                        planner_buffer.append(event.delta)

            planner_text = "".join(planner_buffer)
            logger.info("Planner raw: %s", planner_text[:2000])
            planner_data = _extract_json(planner_text)
            assistant_text = planner_data.get("assistant_text", "")
            plan = planner_data.get("plan", [])
            yield send(
                {
                    "phase": "planner",
                    "type": "phase.done",
                    "assistant_text": assistant_text,
                    "plan": plan,
                }
            )

            yield send({"phase": "diagram", "type": "phase.start", "status": "Building diagram"})
            diagram_context = planner_messages + [
                ChatMessage(
                    role="user",
                    content=f"Plan:\n- " + "\n- ".join(plan)
                    if isinstance(plan, list)
                    else f"Plan:\n{plan}",
                )
            ]
            diagram_buffer = []
            for event in _responses_stream(DIAGRAM_PROMPT, diagram_context, diagram_format):
                payload = {
                    "phase": "diagram",
                    "type": getattr(event, "type", "unknown"),
                    "delta": getattr(event, "delta", None),
                }
                yield send(payload)
                if getattr(event, "type", "") == "response.output_text.delta":
                    if event.delta:
                        diagram_buffer.append(event.delta)

            diagram_text = "".join(diagram_buffer)
            logger.info("Diagram raw: %s", diagram_text[:2000])
            diagram_data = _extract_json(diagram_text)
            diagram_mermaid = diagram_data.get("diagram_mermaid", "")
            yield send(
                {
                    "phase": "diagram",
                    "type": "phase.done",
                    "diagram_mermaid": diagram_mermaid,
                }
            )

            yield send({"phase": "code", "type": "phase.start", "status": "Generating code"})
            code_context = diagram_context + [
                ChatMessage(role="user", content=f"Diagram:\n{diagram_mermaid}")
            ]
            code_buffer = []
            for event in _responses_stream(CODE_PROMPT, code_context, code_format):
                payload = {
                    "phase": "code",
                    "type": getattr(event, "type", "unknown"),
                    "delta": getattr(event, "delta", None),
                }
                yield send(payload)
                if getattr(event, "type", "") == "response.output_text.delta":
                    if event.delta:
                        code_buffer.append(event.delta)

            code_text = "".join(code_buffer)
            logger.info("Code raw: %s", code_text[:2000])
            code_data = _extract_json(code_text)
            agent_code = code_data.get("agent_code", "")
            yield send(
                {
                    "phase": "code",
                    "type": "phase.done",
                    "agent_code": agent_code,
                }
            )
            yield send({"phase": "all", "type": "all.done"})
        except Exception as exc:
            logger.exception("Chat stream failed: %s", exc)
            yield f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.post("/api/run", response_model=RunResponse)
def run_agent(req: RunRequest) -> RunResponse:
    return _run_agent_code(req.agent_code, req.prompt, req.tools)


FRONTEND_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"


@app.get("/")
def serve_root():
    index_path = FRONTEND_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"error": "Frontend not built. Run npm install && npm run build in frontend/."}


@app.get("/run")
def serve_runner():
    index_path = FRONTEND_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"error": "Frontend not built. Run npm install && npm run build in frontend/."}


if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
