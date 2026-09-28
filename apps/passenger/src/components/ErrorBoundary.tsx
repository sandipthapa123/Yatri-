import { Component, type ReactNode } from 'react';

import { ErrorScreen } from '../screens/ErrorScreen';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere below it in the tree so a crash in one
 * screen shows the accessible ErrorScreen instead of a blank app. Bootstrap
 * failures (network, config) are handled separately by useAppBootstrap;
 * this only covers unexpected render exceptions.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    if (__DEV__) {
      console.error('Unhandled error rendering the app:', error, info.componentStack);
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return <ErrorScreen message={this.state.error.message} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
