import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { RelayProvider } from '../relay/relay-context';

export default function RootLayout() {
  return (
    <RelayProvider>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </RelayProvider>
  );
}
