import { EventEmitter } from 'events';

/**
 * Internal EventBus for ANP events.
 * Emits 'utterance' with (event: ANPEvent, session: NodeSessionEntry)
 */
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);
