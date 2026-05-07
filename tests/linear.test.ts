import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinearClient, LinearClientError } from "../src/linear.js";

function response(body: any, ok = true, status = 200) {
  return { ok, status, statusText: String(status), json: async () => body } as Response;
}

describe("LinearClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("paginates candidate issues and normalizes labels/blockers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { issues: {
        nodes: [{ id: "1", identifier: "ENG-1", title: "A", description: null, priority: 2, state: { name: "Todo" }, labels: { nodes: [{ name: "Symphony" }] }, inverseRelations: { nodes: [{ type: "blocks", issue: { id: "B", identifier: "ENG-0", state: { name: "In Progress" } } }] }, createdAt: "2024-01-01T00:00:00Z", updatedAt: null }],
        pageInfo: { hasNextPage: true, endCursor: "cursor1" }
      } } }))
      .mockResolvedValueOnce(response({ data: { issues: {
        nodes: [{ id: "2", identifier: "ENG-2", title: "B", description: "d", priority: null, state: { name: "In Progress" }, labels: { nodes: [] }, inverseRelations: { nodes: [] }, createdAt: "2024-01-02T00:00:00Z", updatedAt: null }],
        pageInfo: { hasNextPage: false, endCursor: null }
      } } }));
    vi.stubGlobal("fetch", fetchMock);

    const issues = await new LinearClient("https://linear.example/graphql", "token").fetchCandidateIssues("PROJ", ["Todo", "In Progress"]);
    expect(issues).toHaveLength(2);
    expect(issues[0].labels).toEqual(["symphony"]);
    expect(issues[0].blocked_by[0].identifier).toBe("ENG-0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.variables.after).toBe("cursor1");
  });

  it("maps GraphQL, HTTP, malformed payload, and missing cursor errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ errors: [{ message: "bad" }] })));
    await expect(new LinearClient("x", "t").fetchCandidateIssues("P", ["Todo"])).rejects.toMatchObject({ category: "linear_graphql_errors" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, false, 500)));
    await expect(new LinearClient("x", "t").fetchCandidateIssues("P", ["Todo"])).rejects.toMatchObject({ category: "linear_api_status" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } })));
    await expect(new LinearClient("x", "t").fetchCandidateIssues("P", ["Todo"])).rejects.toMatchObject({ category: "linear_missing_end_cursor" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ data: { issues: {} } })));
    await expect(new LinearClient("x", "t").fetchCandidateIssues("P", ["Todo"])).rejects.toMatchObject({ category: "linear_unknown_payload" });
  });

  it("refreshes states in ID batches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ data: { issues: { nodes: [{ id: "1", identifier: "ENG-1", title: "A", state: { name: "Done" }, labels: { nodes: [] }, inverseRelations: { nodes: [] } }] } } }));
    vi.stubGlobal("fetch", fetchMock);
    const issues = await new LinearClient("x", "t").fetchIssueStatesByIds(["1"]);
    expect(issues[0].state).toBe("Done");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.variables.ids).toEqual(["1"]);
  });
});
