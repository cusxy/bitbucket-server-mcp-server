# Bitbucket Server MCP - Agent Workflow Guide

Efficient workflow for AI agents using this MCP server.

## Discovery

```
list_projects()                      # Find project keys
list_repositories(project: "KEY")    # Find repository slugs
```

## Pull Request Review

```
1. get_pull_request(repository, prId)    # Get PR metadata, status, reviewers

2. get_diff_stats(repository, prId)      # Check scope (file count, lines changed)
Y
3. Based on stats:
   - Small PR (<50 files):
     get_diff(repository, prId)

   - Large PR:
     get_diff(repository, prId,
       excludePaths: ["**/package-lock.json", "**/*.min.js"],
       maxFiles: 50)

   - Specific files only:
     get_diff_for_files(repository, prId,
       filePaths: ["src/index.ts", "src/utils.ts"])

4. get_comments(repository, prId)        # Read existing discussion
```

## Code Review Actions

```
# General comment
add_comment(repository, prId, text)

# Line-specific feedback
add_comment_inline(repository, prId, text, filePath, line, lineType: "ADDED"|"REMOVED")
```

## Code Exploration

```
browse_repository(repository, path)              # List directory contents
get_file_content(repository, filePath, branch)   # Read file content
search(query, project, repository)               # Find code patterns
```

## PR Lifecycle

```
# Create
create_pull_request(repository, title, sourceBranch, targetBranch, reviewers)

# Merge
merge_pull_request(repository, prId, strategy: "merge-commit"|"squash"|"fast-forward")

# Decline
decline_pull_request(repository, prId, message)
```

## Handling Large PRs (Merge Commits)

Large PRs with thousands of files require a staged approach:

```
1. get_diff_stats(repository, prId)
   → Identify total files, find large files (package-lock.json, etc.)

2. get_diff(repository, prId,
     excludePaths: ["**/package-lock.json", "**/yarn.lock", "**/dist/**"],
     maxFiles: 100,
     maxTotalLines: 20000)
   → Get filtered diff excluding noise

3. get_diff_for_files(repository, prId, filePaths: ["src/critical.ts"])
   → Deep dive into specific files of interest
```

## Filter Patterns

Common `excludePaths` patterns:
- `**/package-lock.json` - npm lock file
- `**/yarn.lock` - yarn lock file
- `**/dist/**` - build output
- `**/*.min.js` - minified files
- `**/vendor/**` - vendored dependencies
- `**/*.generated.*` - generated code

Common `includePaths` patterns:
- `src/**/*.ts` - TypeScript source files
- `**/*.py` - Python files
- `*.md` - Markdown at root level

## Tips

- Always call `get_diff_stats` before `get_diff` on unfamiliar PRs
- Use `excludePaths` to filter generated files, lock files, and vendor code
- Use `maxFiles` and `maxTotalLines` to prevent context overflow
- Set `BITBUCKET_DEFAULT_PROJECT` env var to avoid repeating project key
- Use `contextLines` parameter to control surrounding code context (default: 10)
