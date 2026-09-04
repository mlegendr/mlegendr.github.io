import { describe, expect, it } from "vitest";
import { solveAssignment, type AssignmentEdge } from "@/lib/optimizer/assignment";

describe("min-cost assignment solver", () => {
  it("finds the exact optimum, not the greedy answer", () => {
    // Greedy on week 0 would take team 0 (cost 1) and then be forced into cost 10.
    // The optimum is team 1 in week 0 (cost 2) and team 0 in week 1 (cost 1).
    const edges: AssignmentEdge[] = [
      { weekIndex: 0, teamIndex: 0, cost: 1 },
      { weekIndex: 0, teamIndex: 1, cost: 2 },
      { weekIndex: 1, teamIndex: 0, cost: 1 },
      { weekIndex: 1, teamIndex: 1, cost: 10 },
    ];
    const sol = solveAssignment(2, 2, edges);
    expect(sol.feasible).toBe(true);
    expect(sol.totalCost).toBeCloseTo(3, 12);
    expect(sol.assignment.get(0)).toBe(1);
    expect(sol.assignment.get(1)).toBe(0);
  });

  it("never assigns the same team to two weeks", () => {
    const edges: AssignmentEdge[] = [];
    for (let w = 0; w < 4; w++) {
      for (let t = 0; t < 6; t++) edges.push({ weekIndex: w, teamIndex: t, cost: (t + 1) * 0.1 });
    }
    const sol = solveAssignment(4, 6, edges);
    expect(sol.feasible).toBe(true);
    const used = [...sol.assignment.values()];
    expect(new Set(used).size).toBe(used.length);
  });

  it("gives every week exactly one team when a feasible solution exists", () => {
    const edges: AssignmentEdge[] = [
      { weekIndex: 0, teamIndex: 0, cost: 0.4 },
      { weekIndex: 1, teamIndex: 1, cost: 0.4 },
      { weekIndex: 2, teamIndex: 2, cost: 0.4 },
    ];
    const sol = solveAssignment(3, 3, edges);
    expect(sol.feasible).toBe(true);
    expect(sol.assignment.size).toBe(3);
  });

  it("reports infeasibility instead of inventing an assignment", () => {
    // Two weeks, but both can only use team 0.
    const edges: AssignmentEdge[] = [
      { weekIndex: 0, teamIndex: 0, cost: 1 },
      { weekIndex: 1, teamIndex: 0, cost: 1 },
    ];
    const sol = solveAssignment(2, 1, edges);
    expect(sol.feasible).toBe(false);
    expect(sol.matched).toBe(1);
  });

  it("maximises the number of matched weeks before minimising cost", () => {
    const edges: AssignmentEdge[] = [
      { weekIndex: 0, teamIndex: 0, cost: 0.1 },
      { weekIndex: 0, teamIndex: 1, cost: 5 },
      { weekIndex: 1, teamIndex: 0, cost: 0.1 },
    ];
    const sol = solveAssignment(2, 2, edges);
    expect(sol.matched).toBe(2);
    expect(sol.assignment.get(0)).toBe(1);
    expect(sol.assignment.get(1)).toBe(0);
  });

  it("handles the empty problem", () => {
    const sol = solveAssignment(0, 5, []);
    expect(sol.feasible).toBe(true);
    expect(sol.assignment.size).toBe(0);
  });

  it("solves a full-size 18x32 problem quickly", () => {
    const edges: AssignmentEdge[] = [];
    for (let w = 0; w < 18; w++) {
      for (let t = 0; t < 32; t++) {
        edges.push({ weekIndex: w, teamIndex: t, cost: 0.1 + ((w * 31 + t * 17) % 100) / 200 });
      }
    }
    const started = Date.now();
    const sol = solveAssignment(18, 32, edges);
    expect(sol.feasible).toBe(true);
    expect(new Set(sol.assignment.values()).size).toBe(18);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
