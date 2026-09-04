/**
 * Exact solver for the survivor assignment problem.
 *
 * We must pick exactly one team per remaining week, never reusing a team, and
 * we want to maximise the product of weekly win probabilities:
 *
 *     maximise   prod_w p(team_w, w)
 *   equivalently maximise   sum_w log p(team_w, w)
 *   equivalently minimise   sum_w -log p(team_w, w)
 *
 * That is a bipartite min-cost assignment (weeks on one side, teams on the
 * other) with edges only where a team actually plays and is still available.
 * Because every cost is `-log p >= 0`, a successive-shortest-path min-cost
 * max-flow with Johnson potentials and Dijkstra is both exact and fast at this
 * size (<= 18 weeks x 32 teams).
 *
 * A greedy "take the best team each week" heuristic is NOT used anywhere: it is
 * exactly the failure mode this app exists to avoid.
 */

export interface AssignmentEdge {
  /** Index into the weeks array supplied to {@link solveAssignment}. */
  weekIndex: number;
  /** Index into the teams array supplied to {@link solveAssignment}. */
  teamIndex: number;
  /** Cost to minimise. Must be finite and non-negative. */
  cost: number;
}

export interface AssignmentSolution {
  /** True when every week received a team. */
  feasible: boolean;
  /** weekIndex -> teamIndex, only for weeks that were matched. */
  assignment: Map<number, number>;
  totalCost: number;
  matched: number;
}

interface Arc {
  to: number;
  cap: number;
  cost: number;
  flow: number;
  rev: number;
}

class MinCostMaxFlow {
  private graph: Arc[][];

  constructor(private readonly n: number) {
    this.graph = Array.from({ length: n }, () => [] as Arc[]);
  }

  addEdge(from: number, to: number, cap: number, cost: number): void {
    const a: Arc = { to, cap, cost, flow: 0, rev: this.graph[to].length };
    const b: Arc = { to: from, cap: 0, cost: -cost, flow: 0, rev: this.graph[from].length };
    this.graph[from].push(a);
    this.graph[to].push(b);
  }

  /** Successive shortest paths with potentials. Returns [flow, cost]. */
  run(source: number, sink: number, maxFlow: number): [number, number] {
    const n = this.n;
    const potential = new Float64Array(n);
    let flow = 0;
    let cost = 0;

    while (flow < maxFlow) {
      const dist = new Float64Array(n).fill(Infinity);
      const prevNode = new Int32Array(n).fill(-1);
      const prevArc = new Int32Array(n).fill(-1);
      dist[source] = 0;

      // O(n^2) Dijkstra: n is tiny (<= ~55 nodes), so a heap buys nothing.
      const visited = new Uint8Array(n);
      for (;;) {
        let u = -1;
        let best = Infinity;
        for (let i = 0; i < n; i++) {
          if (!visited[i] && dist[i] < best) {
            best = dist[i];
            u = i;
          }
        }
        if (u === -1) break;
        visited[u] = 1;
        const arcs = this.graph[u];
        for (let ai = 0; ai < arcs.length; ai++) {
          const arc = arcs[ai];
          if (arc.cap - arc.flow <= 0) continue;
          const reduced = arc.cost + potential[u] - potential[arc.to];
          const nd = dist[u] + reduced;
          if (nd < dist[arc.to] - 1e-12) {
            dist[arc.to] = nd;
            prevNode[arc.to] = u;
            prevArc[arc.to] = ai;
          }
        }
      }

      if (!Number.isFinite(dist[sink])) break; // sink unreachable: no more flow

      for (let i = 0; i < n; i++) {
        if (Number.isFinite(dist[i])) potential[i] += dist[i];
      }

      // Every unit of flow here is one week, so push exactly 1 at a time.
      let push = maxFlow - flow;
      for (let v = sink; v !== source; v = prevNode[v]) {
        const arc = this.graph[prevNode[v]][prevArc[v]];
        push = Math.min(push, arc.cap - arc.flow);
      }
      for (let v = sink; v !== source; v = prevNode[v]) {
        const arc = this.graph[prevNode[v]][prevArc[v]];
        arc.flow += push;
        this.graph[v][arc.rev].flow -= push;
        cost += push * arc.cost;
      }
      flow += push;
    }

    return [flow, cost];
  }

  edgesFrom(node: number): Arc[] {
    return this.graph[node];
  }
}

/**
 * Solve the min-cost assignment of `weekCount` weeks to distinct teams.
 */
export function solveAssignment(
  weekCount: number,
  teamCount: number,
  edges: AssignmentEdge[],
): AssignmentSolution {
  if (weekCount === 0) {
    return { feasible: true, assignment: new Map(), totalCost: 0, matched: 0 };
  }

  const source = 0;
  const weekBase = 1;
  const teamBase = weekBase + weekCount;
  const sink = teamBase + teamCount;
  const mcmf = new MinCostMaxFlow(sink + 1);

  for (let w = 0; w < weekCount; w++) mcmf.addEdge(source, weekBase + w, 1, 0);
  for (let t = 0; t < teamCount; t++) mcmf.addEdge(teamBase + t, sink, 1, 0);

  for (const e of edges) {
    if (!Number.isFinite(e.cost)) continue;
    if (e.weekIndex < 0 || e.weekIndex >= weekCount) continue;
    if (e.teamIndex < 0 || e.teamIndex >= teamCount) continue;
    mcmf.addEdge(weekBase + e.weekIndex, teamBase + e.teamIndex, 1, e.cost);
  }

  const [flow, cost] = mcmf.run(source, sink, weekCount);

  const assignment = new Map<number, number>();
  for (let w = 0; w < weekCount; w++) {
    for (const arc of mcmf.edgesFrom(weekBase + w)) {
      if (arc.flow > 0 && arc.to >= teamBase && arc.to < sink) {
        assignment.set(w, arc.to - teamBase);
        break;
      }
    }
  }

  return { feasible: flow === weekCount, assignment, totalCost: cost, matched: flow };
}
