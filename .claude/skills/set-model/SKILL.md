---
name: set-model
description: Configure which LLM model the NanoClaw container agent uses (Ollama, Anthropic, etc.)
---

# Set Model

Configures the LLM model that the NanoClaw container agent uses. Supports Ollama (local models), Anthropic API, and any OpenAI-compatible endpoint.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/config.ts` exports a `CLAUDE_MODEL` constant:

```bash
grep "CLAUDE_MODEL" src/config.ts
```

If found, skip to Phase 3 (Configure).

## Phase 2: Apply Code Changes

### Merge this skill branch

This skill adds named defaults in `src/config.ts`, exports `CLAUDE_MODEL`, and uses it in both the host container runner and the SDK query call inside `container/agent-runner/src/index.ts`.

```bash
git fetch origin skill/set-model
git merge origin/skill/set-model || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This sets `CLAUDE_MODEL` in `.env` as the model name, reads it from config, passes it to the container as the `CLAUDE_MODEL` environment variable, and sets `options.model` explicitly in the SDK so the runtime cannot fall back to `claude-sonnet-4-6`.

### Validate

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Configure

### Choose your model

**Ollama (local):**

- `minimax-m2.7:cloud` — Fast, good coding model
- `qwen3-coder` — Excellent for coding (30B, needs 24GB+ VRAM)
- `glm-4.7:cloud` — High-performance cloud model

**Anthropic:**

- `claude-sonnet-4-6` (default)
- `claude-opus-4-6`
- `claude-haiku-4-5-20250501`

**OpenAI-compatible:**
Any model name your endpoint supports.

### Set the model

```bash
# In .env
CLAUDE_MODEL=minimax-m2.7:cloud
```

Also update if using a different `ANTHROPIC_BASE_URL` for non-Ollama endpoints.

For Ollama, the current code defaults to:

```bash
CLAUDE_MODEL=minimax-m2.7:cloud
ANTHROPIC_BASE_URL=http://host.docker.internal:11434
ANTHROPIC_AUTH_TOKEN=ollama
```

### Sync to container environment

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or if not using launchd:

```bash
pkill -f "node dist/index.js"; node dist/index.js &
```

## Phase 5: Verify

Send a message to the bot in your registered channel. Check logs if it fails:

```bash
tail -f logs/nanoclaw.log
```

## Changing the Model

To change the model later:

1. Edit `CLAUDE_MODEL` in `.env`
2. Sync: `cp .env data/env/env`
3. Restart: `pkill -f "node dist/index.js"; node dist/index.js &`
4. Test in channel

## Troubleshooting

**"model not found" or wrong model used:**

- Verify `CLAUDE_MODEL` is set correctly in `.env`
- Verify the SDK path still sets `options.model` in `container/agent-runner/src/index.ts`
- Ensure `data/env/env` is synced (container reads from there, not `.env`)
- Restart the service after changing the model

**Ollama connection errors:**

- Ensure Ollama is running: `ollama list`
- Check `ANTHROPIC_BASE_URL` points to your Ollama instance (default: `http://host.docker.internal:11434` for Docker, `http://localhost:11434` for Apple Container)
- Pull the model if needed: `ollama pull <model-name>`

**Container still using old model:**
The container caches sessions. Force a fresh container by restarting: `pkill -f nanoclaw-slack` then send a new message.
