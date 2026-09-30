import { Component, type ReactNode } from 'react';

/**
 * Per-message error boundary: if rendering one message throws, only that
 * message falls back (to plain text), never the room or the app. Also covers a failed lazy load.
 */
export class MessageBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // Deliberately silent: the fallback is the plain text of the same message.
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
