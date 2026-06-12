import { AppShell } from './components/layout/AppShell';
import { AuthGate } from './components/auth/AuthGate';

/**
 * Hubble SQL Workbench — application root (design.md §6, §11). `AuthGate` wraps
 * the shell so an unauthenticated proxy session swaps the UI for the
 * "authentication required" screen; in `none` mode the gate is transparent.
 */
export default function App() {
  return (
    <AuthGate>
      <AppShell />
    </AuthGate>
  );
}
