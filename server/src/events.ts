import type { LiveEvent } from '../../shared/types.ts';
type Listener = (event: LiveEvent) => void;

export class Events {
  private listeners = new Map<string, Set<Listener>>();
  private users = new Map<string, Set<Listener>>();

  emitUser(userId: string, event: LiveEvent) {
    for (const listener of this.users.get(userId) ?? []) listener(event);
  }

  subscribeUser(userId: string, listener: Listener) {
    const subscribers = this.users.get(userId) ?? new Set<Listener>();
    subscribers.add(listener);
    this.users.set(userId, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) this.users.delete(userId);
    };
  }

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
