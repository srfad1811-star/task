import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || 'An unexpected application error occurred.',
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Application ErrorBoundary caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let friendly = this.state.errorMessage;
      try {
        const parsed = JSON.parse(this.state.errorMessage);
        if (parsed?.error && parsed?.operationType) {
          friendly = `Cloud database permission error during "${parsed.operationType}" on "${parsed.path ?? 'channels'}": ${parsed.error}`;
        }
      } catch {
        // Keep raw error message
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F8F7F4] p-6">
          <div className="max-w-lg w-full rounded border border-red-200 bg-white p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-2.5 text-red-700">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h2 className="text-sm font-semibold">Application Error</h2>
            </div>
            <p className="text-xs text-[#57534E] leading-relaxed break-words">{friendly}</p>
            <button
              onClick={() => {
                this.setState({ hasError: false, errorMessage: '' });
                window.location.reload();
              }}
              className="inline-flex items-center gap-1.5 rounded bg-[#141413] px-4 py-2 text-xs font-medium text-white hover:bg-[#2A2927]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
