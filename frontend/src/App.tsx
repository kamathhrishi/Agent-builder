import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

const DEFAULT_DIAGRAM = `flowchart LR
  U[User] --> C[Chat Agent]
  C --> P[Planner]
  P --> T[Tools]
  T --> O[Output]
`;

const DEFAULT_CODE = `import os
from typing import List, Dict

class Agent:
    def __init__(self, tools: List[str]):
        self.tools = tools

    def plan(self, task: str) -> List[Dict[str, str]]:
        return [
            {"step": "analyze", "detail": task},
            {"step": "select_tool", "detail": ", ".join(self.tools)},
            {"step": "execute", "detail": "run selected tools"},
            {"step": "summarize", "detail": "return result"},
        ]

    def run(self, task: str) -> str:
        plan = self.plan(task)
        return "\\n".join([f"{p['step']}: {p['detail']}" for p in plan])

if __name__ == "__main__":
    agent = Agent(["search", "codegen", "diagram"])
    print(agent.run("Build a simple agent"))
`;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatResponse = {
  assistant_text: string;
  diagram_mermaid: string;
  agent_code: string;
  raw_text?: string | null;
};

type RunResponse = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
};

type StreamEvent = {
  phase: string;
  type: string;
  delta?: string | null;
  assistant_text?: string;
  plan?: string[];
  diagram_mermaid?: string;
  agent_code?: string;
  error?: string;
  status?: string;
};

function Runner() {
  const FIX_KEY = "agentbuilder.fix.v1";
  const STORAGE_KEY = "agentbuilder.session.v1";
  const [agentCode, setAgentCode] = useState(DEFAULT_CODE);
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { agentCode?: string };
      if (data.agentCode) setAgentCode(data.agentCode);
    } catch {
      // ignore corrupted session data
    }
  }, []);

  const runAgent = async (overridePrompt?: string) => {
    const effectivePrompt = String(overridePrompt ?? prompt ?? "").trim();
    if (!effectivePrompt || isRunning) return;
    setIsRunning(true);
    setStdout("");
    setStderr("");
    setExitCode(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_code: agentCode,
          prompt: effectivePrompt,
          tools: ["search", "codegen", "diagram"],
        }),
      });
      const data = (await res.json()) as RunResponse;
      setStdout(data.stdout || "");
      setStderr(data.stderr || "");
      setExitCode(data.exit_code);
      setLastPrompt(effectivePrompt);
    } catch (err) {
      setStderr(String(err));
      setExitCode(1);
    } finally {
      setIsRunning(false);
    }
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runAgent();
    }
  };

  const sendToBuilder = () => {
    const error = stderr || "Runner failed.";
    const payload = {
      agentCode,
      error,
      lastPrompt: lastPrompt || prompt.trim(),
    };
    localStorage.setItem(FIX_KEY, JSON.stringify(payload));
    window.location.href = "/";
  };

  return (
    <div className="app runner">
      <header className="header">
        <div className="brand">
          <div className="logo">A</div>
          <div>
            <div className="title">Agent Runner</div>
            <div className="subtitle">
              Execute the generated agent in a dedicated chat window.
            </div>
          </div>
        </div>
        <div className="header-actions">
          <a className="ghost-link" href="/">
            Builder
          </a>
        </div>
      </header>

      <div className="runner-layout">
        <section className="panel runner-left">
          <div className="panel-title">Prompt</div>
          <div className="runner-input">
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask the agent to perform a task..."
            />
            <button onClick={() => runAgent()} disabled={!prompt.trim() || isRunning}>
              {isRunning ? "Running..." : "Run Agent"}
            </button>
            <button
              className="ghost-button runner-retry"
              onClick={() => runAgent(lastPrompt)}
              disabled={!lastPrompt || isRunning}
            >
              Retry
            </button>
            <button
              className="ghost-button runner-fix"
              onClick={sendToBuilder}
              disabled={(exitCode === null || exitCode === 0) || isRunning}
            >
              Fix In Builder
            </button>
          </div>
          <div className="runner-output">
            <div className="panel-title">Output</div>
            <pre>
              <code>{stdout ? stdout : "No output yet."}</code>
            </pre>
          </div>
          <div className="runner-meta">
            {exitCode !== null ? (
              <span className={exitCode === 0 ? "ok" : "fail"}>
                Exit code: {exitCode}
              </span>
            ) : (
              <span>Awaiting run</span>
            )}
          </div>
          {stderr ? (
            <div className="runner-errors">
              <div className="panel-title">Errors</div>
              <pre>
                <code>{stderr}</code>
              </pre>
            </div>
          ) : null}
        </section>

        <section className="panel runner-right">
          <div className="panel-title">Agent Code</div>
          <textarea
            className="runner-code"
            value={agentCode}
            onChange={(event) => setAgentCode(event.target.value)}
          />
        </section>
      </div>

      <footer className="footer">
        <div>Runner uses backend `/api/run` with `OPENAI_API_KEY`.</div>
      </footer>
    </div>
  );
}

export default function App() {
  const FIX_KEY = "agentbuilder.fix.v1";
  const isRunner = window.location.pathname.startsWith("/run");
  if (isRunner) {
    return <Runner />;
  }
  const STORAGE_KEY = "agentbuilder.session.v1";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [diagram, setDiagram] = useState(DEFAULT_DIAGRAM);
  const [agentCode, setAgentCode] = useState(DEFAULT_CODE);
  const [rawText, setRawText] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"diagram" | "code">("diagram");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [planSteps, setPlanSteps] = useState<string[]>([]);
  const diagramRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: "base" });
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as {
        messages?: ChatMessage[];
        diagram?: string;
        agentCode?: string;
        rightTab?: "diagram" | "code";
      };
      if (data.messages) setMessages(data.messages);
      if (data.diagram) setDiagram(data.diagram);
      if (data.agentCode) setAgentCode(data.agentCode);
      if (data.rightTab) setRightTab(data.rightTab);
    } catch {
      // ignore corrupted session data
    }
  }, []);

  useEffect(() => {
    const payload = JSON.stringify({
      messages,
      diagram,
      agentCode,
      rightTab,
    });
    localStorage.setItem(STORAGE_KEY, payload);
  }, [messages, diagram, agentCode, rightTab]);

  const clearSession = () => {
    localStorage.removeItem(STORAGE_KEY);
    setMessages([]);
    setDiagram(DEFAULT_DIAGRAM);
    setAgentCode(DEFAULT_CODE);
    setRightTab("diagram");
    setRawText(null);
    setPlanSteps([]);
    setInput("");
  };

  useEffect(() => {
    const renderDiagram = async () => {
      if (!diagramRef.current) return;
      try {
        const { svg } = await mermaid.render("agent-diagram", diagram);
        diagramRef.current.innerHTML = svg;
      } catch (err) {
        diagramRef.current.innerHTML = "<pre>Diagram parse error</pre>";
      }
    };

    renderDiagram();
  }, [diagram]);

  const canSend = input.trim().length > 0 && !isLoading;

  const sendMessageWith = async (content: string) => {
    const clean = String(content ?? "").trim();
    if (!clean || isLoading) return;
    const userMessage: ChatMessage = { role: "user", content: clean };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    setRawText(null);
    setStatusText("Starting...");
    setPlanSteps([]);

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      if (!res.body) {
        throw new Error("No response body from server.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          const dataLines = lines.filter((line) => line.startsWith("data: "));
          if (dataLines.length === 0) continue;
          const dataStr = dataLines.map((l) => l.slice(6)).join("\n");
          try {
            const payload = JSON.parse(dataStr) as StreamEvent;
            if (payload.type === "phase.start" && payload.status) {
              setStatusText(payload.status);
            }
            if (payload.type === "phase.done") {
              if (payload.phase === "planner" && payload.assistant_text) {
                setMessages((prev) => [
                  ...prev,
                  { role: "assistant", content: payload.assistant_text! },
                ]);
              }
              if (payload.phase === "planner" && payload.plan) {
                setPlanSteps(payload.plan);
              }
              if (payload.phase === "diagram" && payload.diagram_mermaid) {
                setDiagram(payload.diagram_mermaid);
              }
              if (payload.phase === "code" && payload.agent_code) {
                setAgentCode(payload.agent_code);
              }
              if (payload.phase === "code") {
                setStatusText(null);
              }
            }
            if ((payload.type === "error" || !payload.type) && payload.error) {
              setRawText(payload.error);
            }
          } catch (err) {
            setRawText(`Failed to parse stream chunk: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Something went wrong. Check the backend logs.",
        },
      ]);
      setRawText(String(err));
    } finally {
      setIsLoading(false);
      setStatusText(null);
    }
  };

  const sendMessage = async () => {
    if (!canSend) return;
    await sendMessageWith(input);
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendMessage();
    }
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FIX_KEY);
      if (!raw) return;
      localStorage.removeItem(FIX_KEY);
      const data = JSON.parse(raw) as {
        agentCode?: string;
        error?: string;
        lastPrompt?: string;
      };
      const fixPrompt = [
        "The runner failed to execute the agent code.",
        data.error ? `Error: ${data.error}` : "",
        "Please update the agent code to be compatible with the runner.",
        "Requirements:",
        "- Must define class Agent",
        "- Must define run(self, task: str) -> str",
        "Here is the current code:",
        data.agentCode ? `\n${data.agentCode}` : "",
        data.lastPrompt ? `\nOriginal agent task: ${data.lastPrompt}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      setInput(fixPrompt);
      setTimeout(() => {
        sendMessageWith(fixPrompt);
      }, 0);
    } catch {
      // ignore corrupted fix payload
    }
  }, []);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="logo">A</div>
          <div>
            <div className="title">Agentbuilder</div>
            <div className="subtitle">
              Build agent architectures with structured prompts, diagrams, and code.
            </div>
          </div>
        </div>
        <div className="header-meta">
          <span>Workspace</span>
          <strong>Agentbuilder</strong>
          <a className="ghost-link" href="/run">
            Runner
          </a>
          <button className="ghost-button" onClick={clearSession}>
            Clear Session
          </button>
        </div>
      </header>

      <div className="layout">
        <section className="panel chat">
          <div className="panel-title">Chat</div>
          <div className="chat-feed">
            {messages.length === 0 ? (
              <div className="chat-empty">
                Ask for an agent design or code changes.
              </div>
            ) : (
              messages.map((msg, idx) => (
                <div key={idx} className={`chat-bubble ${msg.role}`}>
                  <div className="chat-role">{msg.role}</div>
                  <div className="chat-text">{msg.content}</div>
                  {msg.role === "assistant" && idx === messages.length - 1 && planSteps.length > 0 ? (
                    <details className="reasoning-box">
                      <summary>Decisions</summary>
                      <div className="reasoning-list">
                        {planSteps.map((step, stepIdx) => (
                          <div key={`${stepIdx}-${step}`} className="reasoning-item">
                            {step}
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              ))
            )}
            {isLoading && (
              <div className="chat-bubble assistant">
                <div className="chat-role">assistant</div>
                <div className="chat-text">
                  <span className="spinner" aria-hidden="true" />
                  {statusText ? statusText : "Working..."}
                </div>
              </div>
            )}
          </div>
          <div className="chat-input">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Describe the agent you want..."
            />
            <button onClick={sendMessage} disabled={!canSend}>
              Send
            </button>
          </div>
        </section>

        <section className="panel right">
          <div className="panel-tabs">
            <button
              className={rightTab === "diagram" ? "active" : ""}
              onClick={() => setRightTab("diagram")}
            >
              Diagram
            </button>
            <button
              className={rightTab === "code" ? "active" : ""}
              onClick={() => setRightTab("code")}
            >
              Code
            </button>
          </div>
          <div className="right-content">
            <div className={rightTab === "diagram" ? "panel-body diagram-body" : "panel-body diagram-body hidden"}>
              <div className="panel-title">Agent Diagram</div>
              <div className="diagram-canvas" ref={diagramRef} />
            </div>
            <div className={rightTab === "code" ? "panel-body code-body" : "panel-body code-body hidden"}>
              <div className="panel-title">Generated Python</div>
              <pre>
                <code>{agentCode}</code>
              </pre>
            </div>
          </div>
        </section>
      </div>

      <footer className="footer">
        <div>Backend expects `OPENAI_API_KEY` in `backend/.env`.</div>
        {rawText ? (
          <details className="raw">
            <summary>Last raw error</summary>
            <pre>
              <code>{rawText}</code>
            </pre>
          </details>
        ) : null}
      </footer>
    </div>
  );
}
