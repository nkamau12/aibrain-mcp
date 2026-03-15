export interface MemoryDocument {
  id: string;
  content: string;
  summary: string;
  embedding: number[] | null;
  tags: string[];
  agentName: string;
  sessionId: string;
  projectPath: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  contentAndSummary: string;
}

export interface MemorySearchResult {
  id: string;
  content?: string;
  summary: string;
  tags?: string[];
  agentName: string;
  sessionId: string;
  projectPath?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

export interface MemoryFilters {
  agentName?: string;
  sessionId?: string;
  projectPath?: string;
  tags?: string[];
  since?: string;
  until?: string;
}

export interface ResultOptions {
  includeContent?: boolean;
  contentMaxLength?: number;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  filters?: MemoryFilters;
  searchMode?: 'hybrid' | 'fulltext' | 'vector';
  rrfK?: number;
  resultOptions?: ResultOptions;
}

export interface TagCount {
  tag: string;
  count: number;
}
