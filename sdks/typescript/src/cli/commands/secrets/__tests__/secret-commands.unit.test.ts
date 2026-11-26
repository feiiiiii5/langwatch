import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../utils/apiKey", () => ({
  resolveCredentials: vi.fn(async () => ({
    apiKey: "test-key",
    source: "env",
    endpoint: "https://app.langwatch.ai",
    projectId: "proj_123",
  })),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
}));

import { resolveCredentials } from "../../../utils/apiKey";
import { projectScopeNotSupported } from "../../../utils/projectScope";

import { createSecretCommand } from "../create";
import { deleteSecretCommand } from "../delete";
import { getSecretCommand } from "../get";
import { listSecretsCommand } from "../list";
import { updateSecretCommand } from "../update";

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const noop = () => {
  // intentionally empty
};

const mockProcessExit = () => {
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ProcessExitError(code as number);
  });
};

const makeSecret = (overrides = {}) => ({
  id: "secret_abc",
  projectId: "proj_123",
  name: "MY_API_KEY",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("listSecretsCommand()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    mockProcessExit();
  });

  it("lists secrets in table format", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [makeSecret(), makeSecret({ id: "secret_def", name: "DB_PASSWORD" })],
    });

    await listSecretsCommand();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/secrets?projectId=proj_123"),
      expect.objectContaining({ method: "GET", headers: expect.any(Object) }),
    );
  });

  it("returns the raw secret list as the machine payload", async () => {
    const secrets = [makeSecret()];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => secrets,
    });

    const result = await listSecretsCommand();

    // The command no longer decides the format — it hands the payload to the
    // output port, which renders json/yaml/agents/--jq from this one value.
    expect(result?.data).toEqual(secrets);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("exits on API error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "Internal" });
    await expect(listSecretsCommand()).rejects.toThrow(ProcessExitError);
  });
});

describe("getSecretCommand()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    mockProcessExit();
  });

  it("displays secret metadata", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeSecret(),
    });

    await getSecretCommand("secret_abc");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/secrets/secret_abc?projectId=proj_123"),
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("exits when secret not found", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });
    await expect(getSecretCommand("nonexistent")).rejects.toThrow(ProcessExitError);
  });
});

describe("createSecretCommand()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    mockProcessExit();
  });

  it("creates a secret", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeSecret(),
    });

    await createSecretCommand("MY_API_KEY", { value: "sk-123" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/secrets"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("MY_API_KEY"),
      }),
    );
  });

  it("creates a secret with a key-scoped credential that has no projectId", async () => {
    // A legacy project key has no selector: applyProjectScope() returns undefined,
    // so resolution reports no project. The server reads the project off the key.
    vi.mocked(resolveCredentials).mockResolvedValueOnce({
      apiKey: "sk-lw-projectkey",
      source: "env",
      endpoint: "https://app.langwatch.ai",
      projectId: undefined,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => makeSecret(),
    });

    const result = await createSecretCommand("QA_ECHO_KEY", { value: "x" });

    expect(result?.data).toEqual(makeSecret());
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ name: "QA_ECHO_KEY", value: "x" });
    expect(body).not.toHaveProperty("projectId");
  });

  it("still refuses --project with a project key", async () => {
    const refusal = projectScopeNotSupported({
      selector: "other-project",
      keySource: "env-key",
    });
    vi.mocked(resolveCredentials).mockRejectedValueOnce(refusal);

    await expect(createSecretCommand("QA_ECHO_KEY", { value: "x" })).rejects.toThrow(
      refusal.message,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid name format", async () => {
    await expect(createSecretCommand("invalid-name", { value: "test" })).rejects.toThrow(
      ProcessExitError,
    );
  });

  it("exits on conflict (409)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => "Already exists",
    });
    await expect(createSecretCommand("MY_KEY", { value: "val" })).rejects.toThrow(ProcessExitError);
  });
});

describe("updateSecretCommand()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    mockProcessExit();
  });

  it("updates a secret value", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeSecret(),
    });

    await updateSecretCommand("secret_abc", { value: "new-value" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/secrets/secret_abc"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          projectId: "proj_123",
          value: "new-value",
        }),
      }),
    );
  });

  it("exits when secret not found", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });
    await expect(updateSecretCommand("bad_id", { value: "val" })).rejects.toThrow(ProcessExitError);
  });
});

describe("deleteSecretCommand()", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    mockProcessExit();
  });

  it("deletes a secret", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "secret_abc", deleted: true }),
    });

    await deleteSecretCommand("secret_abc");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/secrets/secret_abc"),
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ projectId: "proj_123" }),
      }),
    );
  });

  it("exits when secret not found", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });
    await expect(deleteSecretCommand("bad_id")).rejects.toThrow(ProcessExitError);
  });
});
