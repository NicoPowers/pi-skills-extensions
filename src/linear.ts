export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: Array<{ id: string | null; identifier: string | null; state: string | null }>;
  created_at: string | null;
  updated_at: string | null;
}

export type LinearErrorCategory =
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor";

export class LinearClientError extends Error {
  constructor(public category: LinearErrorCategory, message: string, public details?: unknown) {
    super(message);
    this.name = "LinearClientError";
  }
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface IssuesConnection {
  nodes: any[];
  pageInfo: PageInfo;
}

export class LinearClient {
  constructor(private endpoint: string, private apiKey: string, private timeoutMs = 30000) {}

  private async request(query: string, variables: any = {}): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new LinearClientError("linear_api_status", `Linear API returned HTTP ${res.status}`, { status: res.status, statusText: res.statusText });
      }

      const json = await res.json().catch((error: any) => {
        throw new LinearClientError("linear_unknown_payload", `Linear API returned malformed JSON: ${error?.message ?? error}`);
      });

      if (Array.isArray(json.errors) && json.errors.length > 0) {
        throw new LinearClientError("linear_graphql_errors", `Linear GraphQL error: ${json.errors[0]?.message ?? "unknown"}`, json.errors);
      }

      if (!json || typeof json !== "object" || !json.data) {
        throw new LinearClientError("linear_unknown_payload", "Linear API response missing data", json);
      }

      return json.data;
    } catch (error: any) {
      if (error instanceof LinearClientError) throw error;
      const message = error?.name === "AbortError" ? `Linear API request timed out after ${this.timeoutMs}ms` : `Linear API request failed: ${error?.message ?? error}`;
      throw new LinearClientError("linear_api_request", message);
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateConnection(value: any): IssuesConnection {
    if (!value || !Array.isArray(value.nodes) || !value.pageInfo || typeof value.pageInfo.hasNextPage !== "boolean") {
      throw new LinearClientError("linear_unknown_payload", "Linear issues connection payload is malformed", value);
    }
    return value as IssuesConnection;
  }

  private async fetchPagedIssues(query: string, variables: Record<string, any>, connectionPath: string[] = ["issues"]): Promise<any[]> {
    const nodes: any[] = [];
    let after: string | null = null;

    while (true) {
      const data = await this.request(query, { ...variables, after });
      let connection: any = data;
      for (const part of connectionPath) {
        connection = connection?.[part];
      }
      const issues = this.validateConnection(connection);
      nodes.push(...issues.nodes);

      if (!issues.pageInfo.hasNextPage) break;
      if (!issues.pageInfo.endCursor) {
        throw new LinearClientError("linear_missing_end_cursor", "Linear pagination indicated more pages but endCursor is missing");
      }
      after = issues.pageInfo.endCursor;
    }

    return nodes;
  }

  async fetchCandidateIssues(projectSlug: string, activeStates: string[]): Promise<Issue[]> {
    const query = `
      query GetCandidateIssues($projectSlug: String!, $activeStates: [String!], $after: String) {
        issues(
          first: 50,
          after: $after,
          filter: {
            project: { slugId: { eq: $projectSlug } },
            state: { name: { in: $activeStates } }
          }
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            state { name }
            branchName
            url
            labels { nodes { name } }
            inverseRelations { nodes { type issue { id identifier state { name } } } }
            relations { nodes { type relatedIssue { id identifier state { name } } } }
            createdAt
            updatedAt
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;

    const nodes = await this.fetchPagedIssues(query, { projectSlug, activeStates });
    return nodes.map((node: any) => this.normalizeIssue(node));
  }

  async fetchIssuesByStates(states: string[], projectSlug?: string): Promise<Issue[]> {
    if (states.length === 0) return [];
    const query = `
      query GetIssuesByState($states: [String!], $projectSlug: String, $after: String) {
        issues(
          first: 50,
          after: $after,
          filter: {
            state: { name: { in: $states } },
            project: { slugId: { eq: $projectSlug } }
          }
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            state { name }
            branchName
            url
            labels { nodes { name } }
            inverseRelations { nodes { type issue { id identifier state { name } } } }
            relations { nodes { type relatedIssue { id identifier state { name } } } }
            createdAt
            updatedAt
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const nodes = await this.fetchPagedIssues(query, { states, projectSlug: projectSlug ?? null });
    return nodes.map((node: any) => this.normalizeIssue(node));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const results: Issue[] = [];
    const query = `
      query GetIssuesByIds($ids: [ID!]!) {
        issues(filter: { id: { in: $ids } }) {
          nodes {
            id
            identifier
            title
            description
            priority
            state { name }
            branchName
            url
            labels { nodes { name } }
            inverseRelations { nodes { type issue { id identifier state { name } } } }
            relations { nodes { type relatedIssue { id identifier state { name } } } }
            createdAt
            updatedAt
          }
        }
      }
    `;

    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const data = await this.request(query, { ids: batch });
      if (!data.issues || !Array.isArray(data.issues.nodes)) {
        throw new LinearClientError("linear_unknown_payload", "Linear issue state refresh payload is malformed", data);
      }
      results.push(...data.issues.nodes.map((node: any) => this.normalizeIssue(node)));
    }
    return results;
  }

  private normalizeIssue(node: any): Issue {
    if (!node || typeof node.id !== "string" || typeof node.identifier !== "string") {
      throw new LinearClientError("linear_unknown_payload", "Linear issue node is missing id or identifier", node);
    }

    const inverseBlockers = (node.inverseRelations?.nodes || [])
      .filter((r: any) => r.type === "blocks")
      .map((r: any) => ({
        id: r.issue?.id || null,
        identifier: r.issue?.identifier || null,
        state: r.issue?.state?.name || null,
      }));

    const fallbackBlockers = inverseBlockers.length > 0 ? [] : (node.relations?.nodes || [])
      .filter((r: any) => r.type === "blocks")
      .map((r: any) => ({
        id: r.relatedIssue?.id || null,
        identifier: r.relatedIssue?.identifier || null,
        state: r.relatedIssue?.state?.name || null,
      }));

    return {
      id: node.id,
      identifier: node.identifier,
      title: typeof node.title === "string" ? node.title : node.identifier,
      description: typeof node.description === "string" ? node.description : null,
      priority: typeof node.priority === "number" ? node.priority : null,
      state: node.state?.name || "Unknown",
      branch_name: node.branchName || null,
      url: node.url || null,
      labels: (node.labels?.nodes || []).map((l: any) => String(l.name).toLowerCase()),
      blocked_by: [...inverseBlockers, ...fallbackBlockers],
      created_at: node.createdAt || null,
      updated_at: node.updatedAt || null,
    };
  }
}
