import { Redirect, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRelayContext } from '../relay/relay-context';
import { Button } from '../ui/button';
import { usePalette } from '../ui/use-palette';

// The account: the login, the relay, the install link of the App, and the sign-out.
export default function Account() {
  const palette = usePalette();
  const router = useRouter();
  const relay = useRelayContext();
  const { state } = relay;
  // After the sign-out, or a session that the relay ended, the home screen signs in again.
  if (state.status !== 'signedIn') return <Redirect href="/" />;

  const text = { color: palette.text };
  const muted = [styles.muted, text];
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.background }]}>
      <Pressable
        accessibilityRole="button"
        hitSlop={12}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        style={styles.back}
      >
        <Text style={[styles.backText, { color: palette.tones.blue }]}>‹ Pull requests</Text>
      </Pressable>
      <View style={styles.body}>
        <Text style={muted}>Signed in as</Text>
        <Text style={[styles.login, text]}>{state.connection.login}</Text>
        <Text style={[styles.small, text]}>Relay: {state.connection.url}</Text>
        {state.notice ? <Text style={[styles.notice, text]}>{state.notice}</Text> : null}
        {state.installUrl ? (
          <>
            <Text style={muted}>The boo App is not installed on any account that you can read.</Text>
            <Button
              label="Install the App on GitHub"
              onPress={() => relay.install(state.installUrl!)}
              palette={palette}
            />
            <Button
              label="Check again"
              onPress={() => void relay.checkAgain(state.connection)}
              kind="secondary"
              palette={palette}
            />
          </>
        ) : null}
        <Button
          label={state.signingOut ? 'Signing out…' : 'Sign out'}
          onPress={() => void relay.signOut()}
          kind="secondary"
          palette={palette}
          disabled={state.signingOut}
        />
        <Button
          label="Settings"
          onPress={() => router.push('/settings')}
          kind="secondary"
          palette={palette}
          disabled={state.signingOut}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  back: { paddingHorizontal: 16, paddingVertical: 12, alignSelf: 'flex-start' },
  backText: { fontSize: 17 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  muted: { fontSize: 16, textAlign: 'center', opacity: 0.7 },
  small: { fontSize: 13, textAlign: 'center', opacity: 0.6 },
  notice: { fontSize: 15, textAlign: 'center' },
  login: { fontSize: 24, fontWeight: '600' },
});
