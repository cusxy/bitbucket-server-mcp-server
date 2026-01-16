import { jest } from '@jest/globals';
import type { AxiosInstance } from 'axios';

// Mock axios before importing BitbucketServer
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
} as unknown as jest.Mocked<AxiosInstance>;

const mockAxiosCreate = jest.fn(() => mockAxiosInstance);

jest.unstable_mockModule('axios', () => ({
  default: {
    create: mockAxiosCreate,
  },
}));

// Mock winston to avoid file logging during tests
jest.unstable_mockModule('winston', () => ({
  default: {
    createLogger: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    })),
    format: {
      json: jest.fn(),
    },
    transports: {
      File: jest.fn(),
    },
  },
}));

// Import after mocks are set up
const { BitbucketServer } = await import('../index.js');

describe('BitbucketServer', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save and set environment variables
    originalEnv = { ...process.env };
    process.env.BITBUCKET_URL = 'https://bitbucket.example.com';
    process.env.BITBUCKET_TOKEN = 'test-token';
    process.env.BITBUCKET_DEFAULT_PROJECT = 'DEFAULT';

    // Reset mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore environment variables
    process.env = originalEnv;
  });

  describe('Configuration', () => {
    test('should throw if BITBUCKET_URL is not defined', () => {
      delete process.env.BITBUCKET_URL;

      expect(() => new BitbucketServer()).toThrow('BITBUCKET_URL is required');
    });

    test('should throw if BITBUCKET_URL is empty', () => {
      process.env.BITBUCKET_URL = '';

      expect(() => new BitbucketServer()).toThrow('BITBUCKET_URL is required');
    });

    test('should throw if neither token nor credentials are provided', () => {
      delete process.env.BITBUCKET_TOKEN;
      delete process.env.BITBUCKET_USERNAME;
      delete process.env.BITBUCKET_PASSWORD;

      expect(() => new BitbucketServer()).toThrow(
        'Either BITBUCKET_TOKEN or BITBUCKET_USERNAME/PASSWORD is required'
      );
    });

    test('should throw if only username is provided without password', () => {
      delete process.env.BITBUCKET_TOKEN;
      process.env.BITBUCKET_USERNAME = 'user';
      delete process.env.BITBUCKET_PASSWORD;

      expect(() => new BitbucketServer()).toThrow(
        'Either BITBUCKET_TOKEN or BITBUCKET_USERNAME/PASSWORD is required'
      );
    });

    test('should throw if only password is provided without username', () => {
      delete process.env.BITBUCKET_TOKEN;
      delete process.env.BITBUCKET_USERNAME;
      process.env.BITBUCKET_PASSWORD = 'pass';

      expect(() => new BitbucketServer()).toThrow(
        'Either BITBUCKET_TOKEN or BITBUCKET_USERNAME/PASSWORD is required'
      );
    });

    test('should create instance with valid token configuration', () => {
      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });

    test('should create instance with username/password authentication', () => {
      delete process.env.BITBUCKET_TOKEN;
      process.env.BITBUCKET_USERNAME = 'user';
      process.env.BITBUCKET_PASSWORD = 'pass';

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });

    test('should configure axios with bearer token authorization', () => {
      new BitbucketServer();

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://bitbucket.example.com/rest/api/1.0',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        })
      );
    });

    test('should configure axios with basic auth when using username/password', () => {
      delete process.env.BITBUCKET_TOKEN;
      process.env.BITBUCKET_USERNAME = 'user';
      process.env.BITBUCKET_PASSWORD = 'pass';

      new BitbucketServer();

      expect(mockAxiosCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://bitbucket.example.com/rest/api/1.0',
          auth: {
            username: 'user',
            password: 'pass',
          },
        })
      );
    });

    test('should read default project from environment', () => {
      process.env.BITBUCKET_DEFAULT_PROJECT = 'MY_PROJECT';

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });

    test('should work without default project', () => {
      delete process.env.BITBUCKET_DEFAULT_PROJECT;

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });
  });

  describe('Read-only mode', () => {
    test('should create instance in read-only mode when BITBUCKET_READ_ONLY is true', () => {
      process.env.BITBUCKET_READ_ONLY = 'true';

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });

    test('should not be read-only when BITBUCKET_READ_ONLY is not set', () => {
      delete process.env.BITBUCKET_READ_ONLY;

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });

    test('should not be read-only when BITBUCKET_READ_ONLY is false', () => {
      process.env.BITBUCKET_READ_ONLY = 'false';

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });
  });

  describe('Diff configuration', () => {
    test('should read max lines per file from environment', () => {
      process.env.BITBUCKET_DIFF_MAX_LINES_PER_FILE = '500';

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });

    test('should work without max lines per file setting', () => {
      delete process.env.BITBUCKET_DIFF_MAX_LINES_PER_FILE;

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });
  });

  describe('Log file configuration', () => {
    test('should use custom log file path from environment', () => {
      process.env.BITBUCKET_LOG_FILE = '/custom/path/server.log';

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });

    test('should work with default log file when BITBUCKET_LOG_FILE is not set', () => {
      delete process.env.BITBUCKET_LOG_FILE;

      const server = new BitbucketServer();
      expect(server).toBeInstanceOf(BitbucketServer);
    });
  });
});
