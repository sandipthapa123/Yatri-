import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** What to show instead of the app: the app's own accessible error screen, with a way to try again. */
  fallback: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere below it in the tree so a crash in one screen shows an accessible
 * error screen instead of a blank app. Bootstrap failures (network, configuration) are handled
 * separately by each app's bootstrap; this only covers unexpected render exceptions. Each app supplies
 * its own screen (its wording and branding), the catching and resetting is written once, here.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack: string }) {
    if (__DEV__) {
      // Development only: a release build shows the screen and keeps the details off the device's log.
      console.error('Unhandled error rendering the app:', error, info.componentStack);
    }
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset);
    return this.props.children;
  }
}
