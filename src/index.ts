#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import winston from 'winston';

// Configuration du logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'bitbucket.log' })
  ]
});

interface BitbucketActivity {
  action: string;
  [key: string]: unknown;
}

interface BitbucketConfig {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
  defaultProject?: string;
  maxLinesPerFile?: number;
  readOnly?: boolean;
}

interface RepositoryParams {
  project?: string;
  repository?: string;
}

interface PullRequestParams extends RepositoryParams {
  prId?: number;
}

interface MergeOptions {
  message?: string;
  strategy?: 'merge-commit' | 'squash' | 'fast-forward';
}

interface CommentOptions {
  text: string;
  parentId?: number;
}

interface InlineCommentOptions extends CommentOptions {
  filePath: string;
  line: number;
  lineType: 'ADDED' | 'REMOVED';
}

interface PullRequestInput extends RepositoryParams {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers?: string[];
}

interface ListOptions {
  limit?: number;
  start?: number;
}

interface ListRepositoriesOptions extends ListOptions {
  project?: string;
}

interface SearchOptions extends ListOptions {
  project?: string;
  repository?: string;
  query: string;
  type?: 'code' | 'file';
}

interface FileContentOptions extends ListOptions {
  project?: string;
  repository?: string;
  filePath: string;
  branch?: string;
}

interface DiffFilterOptions {
  includePaths?: string[];
  excludePaths?: string[];
  maxFiles?: number;
  maxTotalLines?: number;
}

interface DiffStatsResult {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    type: string;
  }>;
}

class BitbucketServer {
  private readonly server: Server;
  private readonly api: AxiosInstance;
  private readonly config: BitbucketConfig;

  constructor() {
    this.server = new Server(
      {
        name: 'bitbucket-server-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Configuration initiale à partir des variables d'environnement
    this.config = {
      baseUrl: process.env.BITBUCKET_URL ?? '',
      token: process.env.BITBUCKET_TOKEN,
      username: process.env.BITBUCKET_USERNAME,
      password: process.env.BITBUCKET_PASSWORD,
      defaultProject: process.env.BITBUCKET_DEFAULT_PROJECT,
      maxLinesPerFile: process.env.BITBUCKET_DIFF_MAX_LINES_PER_FILE 
        ? parseInt(process.env.BITBUCKET_DIFF_MAX_LINES_PER_FILE, 10) 
        : undefined,
      readOnly: process.env.BITBUCKET_READ_ONLY === 'true'
    };

    if (!this.config.baseUrl) {
      throw new Error('BITBUCKET_URL is required');
    }

    if (!this.config.token && !(this.config.username && this.config.password)) {
      throw new Error('Either BITBUCKET_TOKEN or BITBUCKET_USERNAME/PASSWORD is required');
    }

    // Configuration de l'instance Axios
    this.api = axios.create({
      baseURL: `${this.config.baseUrl}/rest/api/1.0`,
      headers: this.config.token 
        ? { Authorization: `Bearer ${this.config.token}` }
        : {},
      auth: this.config.username && this.config.password
        ? { username: this.config.username, password: this.config.password }
        : undefined,
    });

    this.setupToolHandlers();
    
    this.server.onerror = (error) => logger.error('[MCP Error]', error);
  }

  private isPullRequestInput(args: unknown): args is PullRequestInput {
    const input = args as Partial<PullRequestInput>;
    return typeof args === 'object' &&
      args !== null &&
      typeof input.project === 'string' &&
      typeof input.repository === 'string' &&
      typeof input.title === 'string' &&
      typeof input.sourceBranch === 'string' &&
      typeof input.targetBranch === 'string' &&
      (input.description === undefined || typeof input.description === 'string') &&
      (input.reviewers === undefined || Array.isArray(input.reviewers));
  }

  private setupToolHandlers() {
    const readOnlyTools = ['list_projects', 'list_repositories', 'get_pull_request', 'get_diff', 'get_diff_stats', 'get_diff_for_files', 'get_reviews', 'get_activities', 'get_comments', 'search', 'get_file_content', 'browse_repository'];
    
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_projects',
          description: 'Discover and list all Bitbucket projects you have access to. Use this first to explore available projects, find project keys, or when you need to work with a specific project but don\'t know its exact key. Returns project keys, names, descriptions and visibility settings.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Number of projects to return (default: 25, max: 1000)' },
              start: { type: 'number', description: 'Start index for pagination (default: 0)' }
            }
          }
        },
        {
          name: 'list_repositories',
          description: 'Browse and discover repositories within a specific project or across all accessible projects. Use this to find repository slugs, explore codebases, or understand the repository structure. Returns repository names, slugs, clone URLs, and project associations.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key to list repositories from. If omitted, uses BITBUCKET_DEFAULT_PROJECT or lists all accessible repositories across projects.' },
              limit: { type: 'number', description: 'Number of repositories to return (default: 25, max: 1000)' },
              start: { type: 'number', description: 'Start index for pagination (default: 0)' }
            }
          }
        },
        {
          name: 'create_pull_request',
          description: 'Create a new pull request to propose code changes, request reviews, or merge feature branches. Use this when you want to submit code for review, merge a feature branch, or contribute changes to a repository. Automatically sets up branch references and can assign reviewers.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable. Use list_projects to discover available projects.' },
              repository: { type: 'string', description: 'Repository slug where the pull request will be created. Use list_repositories to find available repositories.' },
              title: { type: 'string', description: 'Clear, descriptive title for the pull request that summarizes the changes.' },
              description: { type: 'string', description: 'Detailed description of changes, context, and any relevant information for reviewers. Supports Markdown formatting.' },
              sourceBranch: { type: 'string', description: 'Source branch name containing the changes to be merged (e.g., "feature/new-login", "bugfix/security-patch").' },
              targetBranch: { type: 'string', description: 'Target branch where changes will be merged (e.g., "main", "develop", "release/v1.2").' },
              reviewers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of Bitbucket usernames to assign as reviewers for this pull request.'
              }
            },
            required: ['repository', 'title', 'sourceBranch', 'targetBranch']
          }
        },
        {
          name: 'get_pull_request',
          description: 'Retrieve comprehensive details about a specific pull request including status, reviewers, commits, and metadata. Use this to check PR status, review progress, understand changes, or gather information before performing actions like merging or commenting.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Unique pull request ID number (e.g., 123, 456).' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'merge_pull_request',
          description: 'Merge an approved pull request into the target branch. Use this when a PR has been reviewed, approved, and is ready to be integrated. Choose the appropriate merge strategy based on your team\'s workflow and repository history preferences.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to merge.' },
              message: { type: 'string', description: 'Custom merge commit message. If not provided, uses default merge message format.' },
              strategy: {
                type: 'string',
                enum: ['merge-commit', 'squash', 'fast-forward'],
                description: 'Merge strategy: "merge-commit" creates a merge commit preserving branch history, "squash" combines all commits into one, "fast-forward" moves the branch pointer without creating a merge commit.'
              }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'decline_pull_request',
          description: 'Decline or reject a pull request that should not be merged. Use this when changes are not acceptable, conflicts with project direction, or when the PR needs significant rework. This closes the PR without merging.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to decline.' },
              message: { type: 'string', description: 'Reason for declining the pull request. Helps the author understand why it was rejected.' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'add_comment',
          description: 'Add a comment to a pull request for code review, feedback, questions, or discussion. Use this to provide review feedback, ask questions about specific changes, suggest improvements, or participate in code review discussions. Supports threaded conversations.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to comment on.' },
              text: { type: 'string', description: 'Comment text content. Supports Markdown formatting for code blocks, links, and emphasis.' },
              parentId: { type: 'number', description: 'ID of parent comment to reply to. Omit for top-level comments.' }
            },
            required: ['repository', 'prId', 'text']
          }
        },
        {
          name: 'add_comment_inline',
          description: 'Add an inline comment (to specific lines) to the diff of a pull request for code review, feedback, questions, or discussion. Use this to provide review feedback, ask questions about specific changes, suggest improvements, or participate in code review discussions. Supports threaded conversations.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to comment on.' },
              text: { type: 'string', description: 'Comment text content. Supports Markdown formatting for code blocks, links, and emphasis.' },
              parentId: { type: 'number', description: 'ID of parent comment to reply to. Omit for top-level comments.' },
              filePath: { type: 'string', description: 'Path to the file in the repository where the comment should be added (e.g., "src/main.py", "README.md").' },
              line: { type: 'number', description: 'Line number in the file to attach the comment to (1-based).' },
              lineType: { type: 'string', enum: ['ADDED', 'REMOVED'], description: 'Type of change the comment is associated with: ADDED for additions, REMOVED for deletions.' }
            },
            required: ['repository', 'prId', 'text', 'filePath', 'line', 'lineType']
          }
        },
        {
          name: 'get_diff',
          description: 'Retrieve the code differences (diff) for a pull request showing what lines were added, removed, or modified. Use this to understand the scope of changes, review specific code modifications, or analyze the impact of proposed changes before merging. For large PRs (e.g., merge commits), use filtering options or get_diff_stats first.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get diff for.' },
              contextLines: { type: 'number', description: 'Number of context lines to show around changes (default: 10). Higher values provide more surrounding code context.' },
              maxLinesPerFile: { type: 'number', description: 'Maximum number of lines to show per file (default: uses BITBUCKET_DIFF_MAX_LINES_PER_FILE env var). Set to 0 for no limit. Prevents large files from overwhelming the diff output.' },
              includePaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Glob patterns to include (e.g., ["src/**/*.ts", "*.md"]). Only files matching these patterns will be included.'
              },
              excludePaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Glob patterns to exclude (e.g., ["**/package-lock.json", "**/dist/**", "**/*.min.js"]). Files matching these patterns will be excluded.'
              },
              maxFiles: {
                type: 'number',
                description: 'Maximum number of files to include in the diff output (default: no limit). Use to prevent overwhelming output for large PRs.'
              },
              maxTotalLines: {
                type: 'number',
                description: 'Maximum total lines across all files (default: no limit). Diff will stop including files once this limit is reached.'
              }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'get_diff_stats',
          description: 'Get summary statistics for a pull request diff without the full content. Use this first for large PRs to understand the scope of changes before fetching the full diff. Returns file count, total additions/deletions, and per-file statistics.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get diff stats for.' },
              limit: { type: 'number', description: 'Maximum number of files to return in the stats (default: 1000).' },
              start: { type: 'number', description: 'Start index for pagination (default: 0).' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'get_diff_for_files',
          description: 'Get diff for specific files in a pull request. Use this when you only need to see changes for particular files, especially after using get_diff_stats to identify files of interest.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get diff for.' },
              filePaths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific file paths to get diff for (e.g., ["src/index.ts", "README.md"]).'
              },
              contextLines: { type: 'number', description: 'Number of context lines to show around changes (default: 10).' }
            },
            required: ['repository', 'prId', 'filePaths']
          }
        },
        {
          name: 'get_reviews',
          description: 'Fetch the review history and approval status of a pull request. Use this to check who has reviewed the PR, see approval status, understand review feedback, or determine if the PR is ready for merging based on review requirements.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get reviews for.' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'get_activities',
          description: 'Retrieve all activities for a pull request including comments, reviews, commits, and other timeline events. Use this to get the complete activity history and timeline of the pull request.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get activities for.' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'get_comments',
          description: 'Retrieve only the comments from a pull request. Use this when you specifically want to read the discussion and feedback comments without other activities like reviews or commits.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get comments for.' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'search',
          description: 'Search for code or files across repositories. Use this to find specific code patterns, file names, or content within projects and repositories. Searches both file contents and filenames. Supports filtering by project, repository, and query optimization.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query string to look for in code or file names.' },
              project: { type: 'string', description: 'Bitbucket project key to limit search scope. If omitted, searches across accessible projects.' },
              repository: { type: 'string', description: 'Repository slug to limit search to a specific repository within the project.' },
              type: { 
                type: 'string', 
                enum: ['code', 'file'],
                description: 'Query optimization: "file" wraps query in quotes for exact filename matching, "code" uses default search behavior. Both search file contents and filenames.'
              },
              limit: { type: 'number', description: 'Number of results to return (default: 25, max: 100)' },
              start: { type: 'number', description: 'Start index for pagination (default: 0)' }
            },
            required: ['query']
          }
        },
        {
          name: 'get_file_content',
          description: 'Retrieve the content of a specific file from a Bitbucket repository with pagination support. Use this to read source code, configuration files, documentation, or any text-based files. For large files, use start parameter to paginate through content.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the file.' },
              filePath: { type: 'string', description: 'Path to the file in the repository (e.g., "src/main.py", "README.md", "config/settings.json").' },
              branch: { type: 'string', description: 'Branch or commit hash to read from (defaults to main/master branch if not specified).' },
              limit: { type: 'number', description: 'Maximum number of lines to return per request (default: 100, max: 1000).' },
              start: { type: 'number', description: 'Starting line number for pagination (0-based, default: 0).' }
            },
            required: ['repository', 'filePath']
          }
        },
        {
          name: 'browse_repository',
          description: 'Browse and list files and directories in a Bitbucket repository. Use this to explore repository structure, find files, or navigate directories.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug to browse.' },
              path: { type: 'string', description: 'Directory path to browse (empty or "/" for root directory).' },
              branch: { type: 'string', description: 'Branch or commit hash to browse (defaults to main/master branch if not specified).' },
              limit: { type: 'number', description: 'Maximum number of items to return (default: 50).' }
            },
            required: ['repository']
          }
        }
      ].filter(tool => !this.config.readOnly || readOnlyTools.includes(tool.name))
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        logger.info(`Called tool: ${request.params.name}`, { arguments: request.params.arguments });
        const args = request.params.arguments ?? {};

        // Check if tool is allowed in read-only mode
        if (this.config.readOnly && !readOnlyTools.includes(request.params.name)) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Tool ${request.params.name} is not available in read-only mode`
          );
        }

        // Helper function to get project with fallback to default
        const getProject = (providedProject?: string): string => {
          const project = providedProject || this.config.defaultProject;
          if (!project) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Project must be provided either as a parameter or through BITBUCKET_DEFAULT_PROJECT environment variable'
            );
          }
          return project;
        };

        switch (request.params.name) {
          case 'list_projects': {
            return await this.listProjects({
              limit: args.limit as number,
              start: args.start as number
            });
          }

          case 'list_repositories': {
            return await this.listRepositories({
              project: args.project as string,
              limit: args.limit as number,
              start: args.start as number
            });
          }

          case 'create_pull_request': {
            if (!this.isPullRequestInput(args)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Invalid pull request input parameters'
              );
            }
            // Ensure project is set
            const createArgs = { ...args, project: getProject(args.project) };
            return await this.createPullRequest(createArgs);
          }

          case 'get_pull_request': {
            const getPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getPullRequest(getPrParams);
          }

          case 'merge_pull_request': {
            const mergePrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.mergePullRequest(mergePrParams, {
              message: args.message as string,
              strategy: args.strategy as 'merge-commit' | 'squash' | 'fast-forward'
            });
          }

          case 'decline_pull_request': {
            const declinePrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.declinePullRequest(declinePrParams, args.message as string);
          }

          case 'add_comment': {
            const commentPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.addComment(commentPrParams, {
              text: args.text as string,
              parentId: args.parentId as number
            });
          }

           case 'add_comment_inline': {
            const commentPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.addCommentInline(commentPrParams, {
              text: args.text as string,
              parentId: args.parentId as number,
              filePath: args.filePath as string,
              line: args.line as number,
              lineType: args.lineType as 'ADDED' | 'REMOVED'
            });
          }

          case 'get_diff': {
            const diffPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            const filterOptions: DiffFilterOptions = {
              includePaths: args.includePaths as string[],
              excludePaths: args.excludePaths as string[],
              maxFiles: args.maxFiles as number,
              maxTotalLines: args.maxTotalLines as number
            };
            return await this.getDiff(
              diffPrParams,
              args.contextLines as number,
              args.maxLinesPerFile as number,
              filterOptions
            );
          }

          case 'get_diff_stats': {
            const statsPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getDiffStats(
              statsPrParams,
              args.limit as number,
              args.start as number
            );
          }

          case 'get_diff_for_files': {
            const filesDiffParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getDiffForFiles(
              filesDiffParams,
              args.filePaths as string[],
              args.contextLines as number
            );
          }

          case 'get_reviews': {
            const reviewsPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getReviews(reviewsPrParams);
          }

          case 'get_activities': {
            const activitiesPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getActivities(activitiesPrParams);
          }

          case 'get_comments': {
            const commentsPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getComments(commentsPrParams);
          }

          case 'search': {
            return await this.search({
              query: args.query as string,
              project: args.project as string,
              repository: args.repository as string,
              type: args.type as 'code' | 'file',
              limit: args.limit as number,
              start: args.start as number
            });
          }

          case 'get_file_content': {
            return await this.getFileContent({
              project: getProject(args.project as string),
              repository: args.repository as string,
              filePath: args.filePath as string,
              branch: args.branch as string,
              limit: args.limit as number,
              start: args.start as number
            });
          }

          case 'browse_repository': {
            return await this.browseRepository({
              project: getProject(args.project as string),
              repository: args.repository as string,
              path: args.path as string,
              branch: args.branch as string,
              limit: args.limit as number
            });
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        logger.error('Tool execution error', { error });
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Bitbucket API error: ${error.response?.data.message ?? error.message}`
          );
        }
        throw error;
      }
    });
  }

  private async listProjects(options: ListOptions = {}) {
    const { limit = 25, start = 0 } = options;
    const response = await this.api.get('/projects', {
      params: { limit, start }
    });

    const projects = response.data.values || [];
    const summary = {
      total: response.data.size || projects.length,
      showing: projects.length,
      projects: projects.map((project: { key: string; name: string; description?: string; public: boolean; type: string }) => ({
        key: project.key,
        name: project.name,
        description: project.description,
        public: project.public,
        type: project.type
      }))
    };

    return {
      content: [{ 
        type: 'text', 
        text: JSON.stringify(summary, null, 2) 
      }]
    };
  }

  private async listRepositories(options: ListRepositoriesOptions = {}) {
    const { project, limit = 25, start = 0 } = options;
    
    let endpoint: string;
    const params = { limit, start };

    if (project || this.config.defaultProject) {
      // List repositories for a specific project
      const projectKey = project || this.config.defaultProject;
      endpoint = `/projects/${projectKey}/repos`;
    } else {
      // List all accessible repositories
      endpoint = '/repos';
    }

    const response = await this.api.get(endpoint, { params });

    const repositories = response.data.values || [];
    const summary = {
      project: project || this.config.defaultProject || 'all',
      total: response.data.size || repositories.length,
      showing: repositories.length,
      repositories: repositories.map((repo: { 
        slug: string; 
        name: string; 
        description?: string; 
        project?: { key: string }; 
        public: boolean; 
        links?: { clone?: { name: string; href: string }[] }; 
        state: string 
      }) => ({
        slug: repo.slug,
        name: repo.name,
        description: repo.description,
        project: repo.project?.key,
        public: repo.public,
        cloneUrl: repo.links?.clone?.find((link: { name: string; href: string }) => link.name === 'http')?.href,
        state: repo.state
      }))
    };

    return {
      content: [{ 
        type: 'text', 
        text: JSON.stringify(summary, null, 2) 
      }]
    };
  }

  private async createPullRequest(input: PullRequestInput) {
    const response = await this.api.post(
      `/projects/${input.project}/repos/${input.repository}/pull-requests`,
      {
        title: input.title,
        description: input.description,
        fromRef: {
          id: `refs/heads/${input.sourceBranch}`,
          repository: {
            slug: input.repository,
            project: { key: input.project }
          }
        },
        toRef: {
          id: `refs/heads/${input.targetBranch}`,
          repository: {
            slug: input.repository,
            project: { key: input.project }
          }
        },
        reviewers: input.reviewers?.map(username => ({ user: { name: username } }))
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async getPullRequest(params: PullRequestParams) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}`
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async mergePullRequest(params: PullRequestParams, options: MergeOptions = {}) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const { message, strategy = 'merge-commit' } = options;
    
    const response = await this.api.post(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/merge`,
      {
        version: -1,
        message,
        strategy
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async declinePullRequest(params: PullRequestParams, message?: string) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.post(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/decline`,
      {
        version: -1,
        message
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async addComment(params: PullRequestParams, options: CommentOptions) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const { text, parentId } = options;
    
    const response = await this.api.post(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/comments`,
      {
        text,
        parent: parentId ? { id: parentId } : undefined
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async addCommentInline(params: PullRequestParams, options: InlineCommentOptions) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId || !options.filePath || !options.line || !options.lineType) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, prId, filePath, line, and lineType are required'
      );
    }
    
    const { text, parentId } = options;
    
    const response = await this.api.post(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/comments`,
      {
        text,
        parent: parentId ? { id: parentId } : undefined,
        anchor: {
          path: options.filePath,
          lineType: options.lineType,
          line: options.line,
          diffType: 'EFFECTIVE',
          fileType: 'TO',}
      }
    );

    logger.error(response);

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private truncateDiff(diffContent: string, maxLinesPerFile: number): string {
    if (!maxLinesPerFile || maxLinesPerFile <= 0) {
      return diffContent;
    }

    const lines = diffContent.split('\n');
    const result: string[] = [];
    let currentFileLines: string[] = [];
    let currentFileName = '';
    let inFileContent = false;

    for (const line of lines) {
      // Detect file headers (diff --git, index, +++, ---)
      if (line.startsWith('diff --git ')) {
        // Process previous file if any
        if (currentFileLines.length > 0) {
          result.push(...this.truncateFileSection(currentFileLines, currentFileName, maxLinesPerFile));
          currentFileLines = [];
        }
        
        // Extract filename for context
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        currentFileName = match ? match[2] : 'unknown';
        inFileContent = false;
        
        // Always include file headers
        result.push(line);
      } else if (line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
        // Always include file metadata
        result.push(line);
      } else if (line.startsWith('@@')) {
        // Hunk header - marks start of actual file content
        inFileContent = true;
        currentFileLines.push(line);
      } else if (inFileContent) {
        // Collect file content lines for potential truncation
        currentFileLines.push(line);
      } else {
        // Other lines (empty lines between files, etc.)
        result.push(line);
      }
    }

    // Process the last file
    if (currentFileLines.length > 0) {
      result.push(...this.truncateFileSection(currentFileLines, currentFileName, maxLinesPerFile));
    }

    return result.join('\n');
  }

  private truncateFileSection(fileLines: string[], fileName: string, maxLines: number): string[] {
    if (fileLines.length <= maxLines) {
      return fileLines;
    }

    // Count actual content lines (excluding hunk headers)
    const contentLines = fileLines.filter(line => !line.startsWith('@@'));
    const hunkHeaders = fileLines.filter(line => line.startsWith('@@'));

    if (contentLines.length <= maxLines) {
      return fileLines; // No need to truncate if content is within limit
    }

    // Smart truncation: show beginning and end
    const showAtStart = Math.floor(maxLines * 0.6); // 60% at start
    const showAtEnd = Math.floor(maxLines * 0.4);   // 40% at end
    const truncatedCount = contentLines.length - showAtStart - showAtEnd;

    const result: string[] = [];
    
    // Add hunk headers first
    result.push(...hunkHeaders);
    
    // Add first portion
    result.push(...contentLines.slice(0, showAtStart));
    
    // Add truncation message
    result.push('');
    result.push(`[*** FILE TRUNCATED: ${truncatedCount} lines hidden from ${fileName} ***]`);
    result.push(`[*** File had ${contentLines.length} total lines, showing first ${showAtStart} and last ${showAtEnd} ***]`);
    result.push(`[*** Use maxLinesPerFile=0 to see complete diff ***]`);
    result.push('');
    
    // Add last portion
    result.push(...contentLines.slice(-showAtEnd));

    return result;
  }

  private matchesGlobPattern(filePath: string, pattern: string): boolean {
    // Convert glob pattern to regex
    // Supports: *, **, ?
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
      .replace(/\*\*/g, '{{GLOBSTAR}}') // Placeholder for **
      .replace(/\*/g, '[^/]*') // * matches anything except /
      .replace(/\?/g, '[^/]') // ? matches single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, '.*'); // ** matches anything including /

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(filePath);
  }

  private fileMatchesPatterns(filePath: string, includePatterns?: string[], excludePatterns?: string[]): boolean {
    // If exclude patterns exist and file matches any, exclude it
    if (excludePatterns && excludePatterns.length > 0) {
      for (const pattern of excludePatterns) {
        if (this.matchesGlobPattern(filePath, pattern)) {
          return false;
        }
      }
    }

    // If include patterns exist, file must match at least one
    if (includePatterns && includePatterns.length > 0) {
      for (const pattern of includePatterns) {
        if (this.matchesGlobPattern(filePath, pattern)) {
          return true;
        }
      }
      return false; // Didn't match any include pattern
    }

    return true; // No include patterns, and didn't match exclude patterns
  }

  private filterDiff(diffContent: string, filterOptions: DiffFilterOptions): { filtered: string; stats: { includedFiles: number; excludedFiles: number; totalLines: number } } {
    const { includePaths, excludePaths, maxFiles, maxTotalLines } = filterOptions;

    // If no filtering needed, return original
    if (!includePaths?.length && !excludePaths?.length && !maxFiles && !maxTotalLines) {
      return {
        filtered: diffContent,
        stats: { includedFiles: 0, excludedFiles: 0, totalLines: diffContent.split('\n').length }
      };
    }

    const lines = diffContent.split('\n');
    const result: string[] = [];
    let currentFileLines: string[] = [];
    let currentFileName = '';
    let includedFiles = 0;
    let excludedFiles = 0;
    let totalLines = 0;
    let reachedMaxFiles = false;
    let reachedMaxLines = false;

    const flushCurrentFile = () => {
      if (currentFileLines.length === 0) return;

      const shouldInclude = this.fileMatchesPatterns(currentFileName, includePaths, excludePaths);

      if (shouldInclude && !reachedMaxFiles && !reachedMaxLines) {
        // Check maxFiles
        if (maxFiles && includedFiles >= maxFiles) {
          reachedMaxFiles = true;
          excludedFiles++;
          currentFileLines = [];
          return;
        }

        // Check maxTotalLines
        if (maxTotalLines && totalLines + currentFileLines.length > maxTotalLines) {
          reachedMaxLines = true;
          excludedFiles++;
          currentFileLines = [];
          return;
        }

        result.push(...currentFileLines);
        includedFiles++;
        totalLines += currentFileLines.length;
      } else {
        excludedFiles++;
      }
      currentFileLines = [];
    };

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        // Flush previous file
        flushCurrentFile();

        // Extract filename
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        currentFileName = match ? match[2] : '';
        currentFileLines.push(line);
      } else if (currentFileName) {
        currentFileLines.push(line);
      } else {
        // Lines before first file (shouldn't happen often)
        result.push(line);
      }
    }

    // Flush last file
    flushCurrentFile();

    // Add summary if files were filtered out
    if (excludedFiles > 0) {
      result.push('');
      result.push(`[*** DIFF FILTERED: ${excludedFiles} files excluded ***]`);
      if (reachedMaxFiles) {
        result.push(`[*** Reached maxFiles limit of ${maxFiles} ***]`);
      }
      if (reachedMaxLines) {
        result.push(`[*** Reached maxTotalLines limit of ${maxTotalLines} ***]`);
      }
      result.push(`[*** Showing ${includedFiles} files, ${totalLines} lines ***]`);
    }

    return {
      filtered: result.join('\n'),
      stats: { includedFiles, excludedFiles, totalLines }
    };
  }

  private async getDiff(params: PullRequestParams, contextLines: number = 10, maxLinesPerFile?: number, filterOptions?: DiffFilterOptions) {
    const { project, repository, prId } = params;

    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }

    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/diff`,
      {
        params: { contextLines },
        headers: { Accept: 'text/plain' }
      }
    );

    let diffContent = response.data;

    // Apply path filtering if specified
    if (filterOptions) {
      const { filtered } = this.filterDiff(diffContent, filterOptions);
      diffContent = filtered;
    }

    // Determine max lines per file: parameter > env var > no limit
    const effectiveMaxLines = maxLinesPerFile !== undefined
      ? maxLinesPerFile
      : this.config.maxLinesPerFile;

    // Apply per-file truncation
    if (effectiveMaxLines) {
      diffContent = this.truncateDiff(diffContent, effectiveMaxLines);
    }

    return {
      content: [{ type: 'text', text: diffContent }]
    };
  }

  private async getDiffStats(params: PullRequestParams, limit: number = 1000, start: number = 0): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { project, repository, prId } = params;

    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }

    // Fetch the changes (file list) for the PR
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/changes`,
      {
        params: { limit, start }
      }
    );

    const changes = response.data.values || [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    interface ChangeEntry {
      path?: { toString?: string };
      srcPath?: { toString?: string };
      type?: string;
      nodeType?: string;
      properties?: {
        gitChangeType?: string;
        linesAdded?: number;
        linesRemoved?: number;
      };
    }

    const files = changes.map((change: ChangeEntry) => {
      const additions = change.properties?.linesAdded || 0;
      const deletions = change.properties?.linesRemoved || 0;
      totalAdditions += additions;
      totalDeletions += deletions;

      return {
        path: change.path?.toString || change.srcPath?.toString || 'unknown',
        additions,
        deletions,
        type: change.type || change.nodeType || 'MODIFY'
      };
    });

    const result: DiffStatsResult = {
      totalFiles: response.data.size || files.length,
      totalAdditions,
      totalDeletions,
      files
    };

    // Add pagination info if not last page
    const paginationInfo = {
      ...result,
      isLastPage: response.data.isLastPage,
      nextStart: response.data.nextPageStart,
      showing: files.length
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(paginationInfo, null, 2) }]
    };
  }

  private async getDiffForFiles(params: PullRequestParams, filePaths: string[], contextLines: number = 10): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { project, repository, prId } = params;

    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }

    if (!filePaths || filePaths.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'filePaths array is required and must not be empty'
      );
    }

    // Fetch diffs for each specified file
    const diffs: string[] = [];
    const errors: string[] = [];

    for (const filePath of filePaths) {
      try {
        const response = await this.api.get(
          `/projects/${project}/repos/${repository}/pull-requests/${prId}/diff/${filePath}`,
          {
            params: { contextLines },
            headers: { Accept: 'text/plain' }
          }
        );
        diffs.push(`=== ${filePath} ===\n${response.data}`);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          errors.push(`File not found in diff: ${filePath}`);
        } else {
          throw error;
        }
      }
    }

    let result = diffs.join('\n\n');
    if (errors.length > 0) {
      result += `\n\n[*** WARNINGS ***]\n${errors.join('\n')}`;
    }

    return {
      content: [{ type: 'text', text: result }]
    };
  }

  private async getReviews(params: PullRequestParams) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/activities`
    );

    const reviews = response.data.values.filter(
      (activity: BitbucketActivity) => activity.action === 'APPROVED' || activity.action === 'REVIEWED'
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(reviews, null, 2) }]
    };
  }

  private async getActivities(params: PullRequestParams) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/activities`
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async getComments(params: PullRequestParams) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/activities`
    );

    const comments = response.data.values.filter(
      (activity: BitbucketActivity) => activity.action === 'COMMENTED'
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(comments, null, 2) }]
    };
  }

  private async search(options: SearchOptions) {
    const { query, project, repository, type, limit = 25, start = 0 } = options;
    
    if (!query) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Query parameter is required'
      );
    }

    // Build the search query with filters
    let searchQuery = query;
    
    // Add project filter if specified
    if (project) {
      searchQuery = `${searchQuery} project:${project}`;
    }
    
    // Add repository filter if specified (requires project)
    if (repository && project) {
      searchQuery = `${searchQuery} repo:${project}/${repository}`;
    }
    
    // Add file extension filter if type is specified
    if (type === 'file') {
      // For file searches, wrap query in quotes for exact filename matching
      if (!query.includes('ext:') && !query.startsWith('"')) {
        searchQuery = `"${query}"`;
        if (project) searchQuery += ` project:${project}`;
        if (repository && project) searchQuery += ` repo:${project}/${repository}`;
      }
    } else if (type === 'code' && !query.includes('ext:')) {
      // For code searches, add common extension filters if not specified
      // This can be enhanced based on user needs
    }

    const requestBody = {
      query: searchQuery,
      entities: {
        code: {
          start,
          limit: Math.min(limit, 100)
        }
      }
    };

    try {
      // Use full URL for search API since it uses different base path
      const searchUrl = `${this.config.baseUrl}/rest/search/latest/search`;
      const response = await axios.post(searchUrl, requestBody, {
        headers: this.config.token
          ? { 
              Authorization: `Bearer ${this.config.token}`,
              'Content-Type': 'application/json'
            }
          : { 'Content-Type': 'application/json' },
        auth: this.config.username && this.config.password
          ? { username: this.config.username, password: this.config.password }
          : undefined,
      });
      
      const codeResults = response.data.code || {};
      const searchResults = {
        query: searchQuery,
        originalQuery: query,
        project: project || 'global',
        repository: repository || 'all',
        type: type || 'code',
        scope: response.data.scope || {},
        total: codeResults.count || 0,
        showing: codeResults.values?.length || 0,
        isLastPage: codeResults.isLastPage || true,
        nextStart: codeResults.nextStart || null,
        results: codeResults.values?.map((result: any) => ({
          repository: result.repository,
          file: result.file,
          hitCount: result.hitCount || 0,
          pathMatches: result.pathMatches || [],
          hitContexts: result.hitContexts || []
        })) || []
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(searchResults, null, 2) }]
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new McpError(
            ErrorCode.InternalError,
            'Search API endpoint not available on this Bitbucket instance'
          );
        }
        // Handle specific search API errors
        const errorData = error.response?.data;
        if (errorData?.errors && errorData.errors.length > 0) {
          const firstError = errorData.errors[0];
          throw new McpError(
            ErrorCode.InvalidParams,
            `Search error: ${firstError.message || 'Invalid search query'}`
          );
        }
      }
      throw error;
    }
  }

  private async getFileContent(options: FileContentOptions) {
    const { project, repository, filePath, branch, limit = 100, start = 0 } = options;
    
    if (!project || !repository || !filePath) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and filePath are required'
      );
    }

    const params: Record<string, string | number> = {
      limit: Math.min(limit, 1000),
      start
    };

    if (branch) {
      params.at = branch;
    }

    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/browse/${filePath}`,
      { params }
    );

    const fileContent = {
      project,
      repository,
      filePath,
      branch: branch || 'default',
      isLastPage: response.data.isLastPage,
      size: response.data.size,
      showing: response.data.lines?.length || 0,
      startLine: start,
      lines: response.data.lines?.map((line: { text: string }) => line.text) || []
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(fileContent, null, 2) }]
    };
  }

  private async browseRepository(options: { project: string; repository: string; path?: string; branch?: string; limit?: number }) {
    const { project, repository, path = '', branch, limit = 50 } = options;
    
    if (!project || !repository) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project and repository are required'
      );
    }

    const params: Record<string, string | number> = {
      limit
    };

    if (branch) {
      params.at = branch;
    }

    const browsePath = path ? `/${path}` : '';
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/browse${browsePath}`,
      { params }
    );

    const children = response.data.children || {};
    const browseResults = {
      project,
      repository,
      path: path || 'root',
      branch: branch || response.data.revision || 'default',
      isLastPage: children.isLastPage || false,
      size: children.size || 0,
      showing: children.values?.length || 0,
      items: children.values?.map((item: { 
        path: { name: string; toString: string }; 
        type: string; 
        size?: number 
      }) => ({
        name: item.path.name,
        path: item.path.toString,
        type: item.type,
        size: item.size
      })) || []
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(browseResults, null, 2) }]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Bitbucket MCP server running on stdio');
  }
}

const server = new BitbucketServer();
server.run().catch((error) => {
  logger.error('Server error', error);
  process.exit(1);
});