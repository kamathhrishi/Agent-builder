# Agentbuilder

Agentbuilder is a simple web app for designing agent architectures. You chat with an LLM, and it produces:
- A professional summary response
- A Mermaid diagram of the agent building blocks
- A Python agent skeleton that includes an OpenAI API call

![Agentbuilder UI](screenshot.png)

This project is still in progress. Stay tuned for updates.

## Features
- Streaming responses with phase status (planning → diagram → code)
- Clean, enterprise-style UI
- Diagram and code tabs
- Local session persistence

## Project structure
- `backend/` FastAPI server + OpenAI Responses API calls
- `frontend/` React + TypeScript UI (built and served by backend)

## Run locally
1. Backend env:
   - Copy `backend/.env.example` to `backend/.env`
   - Set `OPENAI_API_KEY`
2. Install frontend deps:
   - `cd frontend`
   - `npm install`
   - `npm run build`
3. Start backend:
   - `cd ..`
   - `python -m uvicorn backend.app:app --reload --port 8001`
4. Open:
   - `http://localhost:8001`

## Notes
- The backend serves the built frontend from `frontend/dist`.
- If you change frontend code, run `npm run build` again.

## Roadmap
- Conversation management (multi-session)
- Shareable agent diagrams and code exports
- More flexible prompt templates
