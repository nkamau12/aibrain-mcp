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
  cluster: string;
  /** JSON-serialized Array<RelatedId> */
  related_ids: string;
  is_stale?: boolean;
}

export interface RelatedId {
  id: string;
  relation_type: 'supersedes' | 'caused-by' | 'see-also' | 'follow-up' | 'similar';
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
  cluster?: string;
  related_ids?: RelatedId[];
  is_stale?: boolean;
}

export interface RelatedMemorySummary {
  id: string;
  summary: string;
  relation_type: RelatedId['relation_type'];
  depth: number;
}

export interface MemorySearchResultWithRelated extends MemorySearchResult {
  related?: RelatedMemorySummary[];
}

export interface MemoryFilters {
  agentName?: string;
  sessionId?: string;
  projectPath?: string;
  tags?: string[];
  since?: string;
  until?: string;
  cluster?: string;
  include_stale?: boolean;
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
  include_related?: boolean;
  related_depth?: number;
  include_stale?: boolean;
}

export interface TagCount {
  tag: string;
  count: number;
}
