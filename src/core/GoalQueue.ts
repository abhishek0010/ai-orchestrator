import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentDomain, Goal, GoalStatus } from '../types/index.js';


export class GoalQueue {
  private readonly queueFile: string;

  constructor(projectRoot: string) {
    const dir = join(projectRoot, '.claude');
    mkdirSync(dir, { recursive: true });
    this.queueFile = join(dir, 'goals.json');
  }

  push(description: string, domains?: readonly AgentDomain[]): Goal {
    const goals = this.readAll();
    const base = {
      id: randomUUID(),
      description,
      projectRoot: process.cwd(),
      status: 'pending' as GoalStatus,
      createdAt: new Date().toISOString(),
    };
    const goal: Goal = domains !== undefined ? { ...base, domains } : base;
    goals.push(goal);
    this.writeAll(goals);
    return goal;
  }

  list(): Goal[] {
    return this.readAll();
  }

  nextPending(): Goal | undefined {
    return this.readAll().find(g => g.status === 'pending');
  }

  /** Mark a pending goal as running. Returns the updated goal or undefined if not claimable. */
  claim(id: string): Goal | undefined {
    const goals = this.readAll();
    const goal = goals.find(g => g.id === id);
    if (goal === undefined || goal.status !== 'pending') return undefined;
    goal.status = 'running';
    goal.startedAt = new Date().toISOString();
    this.writeAll(goals);
    return goal;
  }

  complete(id: string, result: string): void {
    this.patch(id, { status: 'done', completedAt: new Date().toISOString(), result });
  }

  fail(id: string, error: string): void {
    this.patch(id, { status: 'failed', completedAt: new Date().toISOString(), error });
  }

  /** Reset any goals stuck in 'running' (e.g. from a crashed process) back to 'pending'. */
  resetStale(): number {
    const goals = this.readAll();
    let count = 0;
    for (const goal of goals) {
      if (goal.status === 'running') {
        goal.status = 'pending';
        count++;
      }
    }
    if (count > 0) this.writeAll(goals);
    return count;
  }

  /**
   * Atomically enqueue pre-built Goal objects (used by decompose_goal tool).
   * Maintains backward compatibility by returning void.
   */
  public pushMany(newGoals: readonly Goal[]): void {
    if (newGoals.length === 0) {
      return;
    }
    const existing = this.readAll();
    try {
      this.writeAll([...existing, ...newGoals]);
    } catch (e) {
      // Preserve original error semantics.
      throw e;
    }
  }

  public nextReady(): Goal | undefined {
    const goals = this.readAll();
    const ready = goals.filter(goal => {
      if (goal.status !== 'pending') return false;
      if (goal.dependsOn && goal.dependsOn.some(dep => !this.isCompleted(dep, goals))) return false;
      return true;
    });
    if (ready.length === 0) return undefined;
    ready.sort((a, b) => {
      const pa = a.priority ?? 50;
      const pb = b.priority ?? 50;
      if (pb !== pa) return pb - pa;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    return ready[0];
  }

  /**
   * Add a goal to the queue, ensuring a default priority of 50 if none is provided.
   * Does not mutate the caller's object; creates a shallow copy instead.
   */
  public add(goal: Goal): void {
    const storedGoal = { ...goal, priority: goal.priority ?? 50 };
    const goals = this.readAll();
    goals.push(storedGoal);
    this.writeAll(goals);
  }

  /**
   * Record a human-provided answer for a goal and reset its status to pending.
   * Does not affect goals that are already completed.
   */
  public answer(id: string, answer: string): void {
    const goals = this.readAll();
    const goal = goals.find(g => g.id === id);
    if (!goal) return;
    // Do not modify already completed goals.
    if (goal.status === 'done' || goal.status === 'failed') return;
    goal.humanAnswer = answer;
    goal.status = 'pending';
    this.writeAll(goals);
  }

  private patch(id: string, patch: Partial<Goal>): void {
    const goals = this.readAll();
    const idx = goals.findIndex(g => g.id === id);
    const goal = goals[idx];
    if (goal === undefined) return;
    Object.assign(goal, patch);
    this.writeAll(goals);
  }

  private readAll(): Goal[] {
    if (!existsSync(this.queueFile)) return [];
    try {
      const raw = readFileSync(this.queueFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Goal[]) : [];
    } catch {
      return [];
    }
  }

  private writeAll(goals: Goal[]): void {
    writeFileSync(this.queueFile, JSON.stringify(goals, null, 2) + '\n', 'utf8');
  }

  private isCompleted(id: string, goals: Goal[]): boolean {
    const goal = goals.find(g => g.id === id);
    return goal !== undefined && goal.status === 'done';
  }
}
