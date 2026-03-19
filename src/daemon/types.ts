export type ExposedModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
};

export type UsageData = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
};

export type UsageTrackingEntry = UsageData & {
  id: string;
  timestamp: number;
  modelId: string;
  baseUrl: string;
  requestId: string;
  client?: string;
  sessionId?: string;
  tags?: string[];
};
