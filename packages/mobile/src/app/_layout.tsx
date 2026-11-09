import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PullsProvider } from '../pulls/pulls-context';
import { RelayProvider } from '../relay/relay-context';

export default function RootLayout() {
  return (
    <RelayProvider>
      <PullsProvider>
        <Stack screenOptions={{ headerShown: false }} />
        <StatusBar style="auto" />
      </PullsProvider>
    </RelayProvider>
  );
}
