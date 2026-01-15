# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server that provides tools for interacting with Bitbucket Server's REST API. It enables AI assistants to manage pull requests, browse repositories, search code, and perform other Bitbucket operations.

## Common Commands

```bash
# Build the project (compiles TypeScript to build/)
npm run build

# Run tests
npm test

# Run a single test file
npx jest src/__tests__/index.test.ts

# Lint the code
npm run lint

# Format code with Prettier
npm run format

# Watch mode for development
npm run dev

# Run with MCP inspector for debugging
npm run dev:server
npm run inspector
```

## Architecture

The entire server is implemented in a single file `src/index.ts` containing:

- **BitbucketServer class**: Main MCP server implementation
  - Initializes the MCP server with tool capabilities
  - Configures axios instance for Bitbucket API calls
  - Registers tool handlers via `setupToolHandlers()`

- **Configuration**: Read from environment variables (`BITBUCKET_URL`, `BITBUCKET_TOKEN`, etc.)

- **Tool System**:
  - Tools are defined in `ListToolsRequestSchema` handler with JSON Schema input definitions
  - Tool execution handled in `CallToolRequestSchema` handler with a switch statement
  - Read-only mode (`BITBUCKET_READ_ONLY=true`) filters available tools

- **Key Interfaces**:
  - `BitbucketConfig`: Server configuration
  - `PullRequestParams`: Common PR operation parameters
  - `RepositoryParams`: Common repository parameters

## API Patterns

- All API calls use axios with base URL `${BITBUCKET_URL}/rest/api/1.0`
- Search uses a separate endpoint: `${BITBUCKET_URL}/rest/search/latest/search`
- Authentication: Bearer token or Basic auth (username/password)
- All tool responses return `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`

## Environment Variables

Required:
- `BITBUCKET_URL`: Bitbucket Server base URL
- `BITBUCKET_TOKEN` OR `BITBUCKET_USERNAME`/`BITBUCKET_PASSWORD`: Authentication

Optional:
- `BITBUCKET_DEFAULT_PROJECT`: Default project key
- `BITBUCKET_DIFF_MAX_LINES_PER_FILE`: Truncate large diffs
- `BITBUCKET_READ_ONLY`: Enable read-only mode
