export type HistoryDirection = "undo" | "redo";

export interface HistoryGroups {
  undo: number[];
  redo: number[];
}

export function createHistoryGroups(): HistoryGroups {
  return { undo: [], redo: [] };
}

export function clearHistoryGroups(groups: HistoryGroups): void {
  groups.undo = [];
  groups.redo = [];
}

export function hasHistoryGroup(
  groups: HistoryGroups,
  direction: HistoryDirection,
): boolean {
  return (direction === "undo" ? groups.undo : groups.redo).length > 0;
}

export function recordHistoryGroup(
  groups: HistoryGroups,
  transactions: number,
): void {
  if (transactions < 1) return;
  groups.undo.push(transactions);
  groups.redo = [];
}

export function takeHistoryGroup(
  groups: HistoryGroups,
  direction: HistoryDirection,
): number {
  const source = direction === "undo" ? groups.undo : groups.redo;
  const destination = direction === "undo" ? groups.redo : groups.undo;
  const transactions = source.pop() ?? 1;
  destination.push(transactions);
  return transactions;
}
