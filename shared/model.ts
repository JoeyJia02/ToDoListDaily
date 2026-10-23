export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high';
export interface Task {
  id: string;
  title: string;
  description: string;
  date: string;
  estimatedMinutes: number;
  actualMinutes: number | null;
  category: string;
  priority: TaskPriority;
  status: TaskStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
}
export interface DaySummary {
  total: number;
  completed: number;
  totalMinutes: number;
  completedMinutes: number;
  progress: number;
}
export interface PlannerState {
  revision: number;
  timezone: string;
  today: string;
  tasks: Task[];
  summary: Record<string, DaySummary>;
}
export type OperationName = 'listTasks' | 'getTask' | 'createTask' | 'updateTask' | 'moveTask' | 'deleteTask' | 'reorderTasks' | 'previewChanges' | 'applyChanges' | 'undoChanges';
