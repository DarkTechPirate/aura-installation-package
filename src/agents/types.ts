export interface AgentConfig {
  id:          string;
  name:        string;
  description: string;
  persona:     string;
  channels:    string[];
  skills:      string[];
  llm_tier:    'simple' | 'complex' | 'vision' | 'creative' | 'offline';
  voice_id:    string | null;
  memory_ns:   string;
}

export interface AgentProfile extends AgentConfig {
  loaded_at: number;
}

export interface NodeSession {
  node_id:    string;
  session_id: string;
  token:      string;
  caps:       string[];
  meta:       Record<string, unknown>;
  connected_at: number;
}
