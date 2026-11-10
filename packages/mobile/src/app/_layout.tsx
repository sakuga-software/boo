import { useFonts } from 'expo-font';
import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityProvider } from '../activity/activity-context';
import { PullsProvider } from '../pulls/pulls-context';
import { PushProvider } from '../push/push-context';
import { RelayProvider } from '../relay/relay-context';
import { SettingsProvider } from '../settings/settings-context';
import { FONT_FILES } from '../ui/fonts';
import { usePalette } from '../ui/use-palette';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, failed] = useFonts(FONT_FILES);
  const palette = usePalette();
  const ready = loaded || failed !== null;
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  // A font that fails to load leaves the font of the system: the app must still open.
  if (!ready) return null;
  return (
    <RelayProvider>
      <PullsProvider>
        <ActivityProvider>
          <SettingsProvider>
            <PushProvider>
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen
                  name="merge/[owner]/[repo]/[number]"
                  options={{
                    presentation: 'transparentModal',
                    animation: 'fade',
                    contentStyle: { backgroundColor: 'transparent' },
                  }}
                />
              </Stack>
              <StatusBar style="auto" />
            </PushProvider>
          </SettingsProvider>
        </ActivityProvider>
      </PullsProvider>
    </RelayProvider>
  );
}
