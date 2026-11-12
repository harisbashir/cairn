import type { LiveEvent } from '../../shared/types.ts';
type Listener = (event: LiveEvent) => void;

export class Events {
  private listeners = new Map<string, Set<Listener>>();

  emit(workspaceId: string, event: LiveEvent) {
    for (const listener of this.listeners.get(workspaceId) ?? []) listener(event);
  }

  subscribe(workspaceId: string, listener: Listener) {
    const subscribers = this.listeners.get(workspaceId) ?? new Set<Listener>();
    subscribers.add(listener);
    this.listeners.set(workspaceId, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) this.listeners.delete(workspaceId);
    };
  }
}
