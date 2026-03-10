export type NodeCap =
  | 'audio_in' | 'audio_out' | 'camera' | 'display'
  | 'led' | 'imu' | 'haptic' | 'battery'
  | 'text_in' | 'text_out' | 'notifications' | 'ble_relay';

export type ANPHello = {
  anp:     '1.0';
  type:    'hello';
  node_id: string;
  token:   string;
  caps:    NodeCap[];
  meta:    Record<string, unknown>;
};

export type ANPWelcome = {
  type:                   'welcome';
  node_id:                string;
  session_id:             string;
  gateway_v:              string;
  heartbeat_interval_sec: number;
};

export type ANPReject = {
  type:   'reject';
  code:   401 | 409;
  reason: string;
};

export type RoutingHint = 'simple' | 'complex' | 'vision' | 'local_vision' | 'creative';

/** Metadata for a file attached to an incoming message (non-image types). */
export type IncomingAttachment = {
  type:       'document' | 'audio' | 'video' | 'voice' | 'sticker';
  file_id?:   string;   // Channel-specific file reference
  filename?:  string;
  mime_type?: string;
  caption?:   string;
};

export type UtterancePayload = {
  text:               string;
  confidence?:        number;
  image_b64?:         string | null;        // Base64-encoded image (triggers vision tier)
  attachments?:       IncomingAttachment[]; // Non-image media attached to the message
  routing_hint?:      RoutingHint;
  workflow_disabled?: boolean;              // When true, skip hybrid orchestrator — pure LLM loop
  context?: { battery?: number; activity?: string; time_of_day?: string };
};

export type ANPEvent = {
  type:       'event';
  event:      'utterance' | 'camera_frame' | 'sensor' | 'status';
  node_id:    string;
  session_id: string;
  ts:         number;
  payload:    UtterancePayload | Record<string, unknown>;
};

export type ANPCommand = {
  type:    'command';
  target:  string;
  cmd:     'speak' | 'led' | 'display' | 'alert' | 'ota_update' | 'audio_chunk';
  payload: SpeakPayload | LEDPayload | AlertPayload | AudioChunkPayload | Record<string, unknown>;
};

export type SpeakPayload      = { text: string; voice?: string; display?: string; led?: LEDColor };
export type LEDPayload        = { pattern: LEDPattern; color: LEDColor; duration_ms?: number };
export type AlertPayload      = { text: string; led?: LEDColor; haptic?: HapticType; priority?: Priority };
export type AudioChunkPayload = { chunk_b64: string; seq: number; final: boolean };

export type LEDPattern = 'solid' | 'pulse' | 'breathing' | 'spin' | 'off';
export type LEDColor   = 'green' | 'blue' | 'amber' | 'red' | 'white' | 'off';
export type HapticType = 'single' | 'double_pulse' | 'long' | 'none';
export type Priority   = 'high' | 'normal' | 'silent';

export type ANPPing = { type: 'ping'; ts: number };
export type ANPPong = { type: 'pong'; ts: number };

export type ANPMessage = ANPHello | ANPWelcome | ANPReject | ANPEvent | ANPCommand | ANPPing | ANPPong;
