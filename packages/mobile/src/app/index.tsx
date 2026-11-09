import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useRelayContext } from '../relay/relay-context';

// The home screen: the sign-in to the relay, then the account. The list of the pull requests comes later.
export default function Home() {
  const dark = useColorScheme() === 'dark';
  const palette = dark ? colors.dark : colors.light;
  const relay = useRelayContext();
  const router = useRouter();
  const { state } = relay;
  const text = { color: palette.text };
  const muted = [styles.muted, text];

  const button = (label: string, onPress: () => void, kind: 'primary' | 'secondary' = 'primary', disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary'
          ? { backgroundColor: palette.accent }
          : { borderColor: palette.border, borderWidth: StyleSheet.hairlineWidth },
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, { color: kind === 'primary' ? '#ffffff' : palette.text }]}>{label}</Text>
    </Pressable>
  );

  let body: ReactNode;
  if (state.status === 'loading') body = <ActivityIndicator />;
  else if (state.status === 'signedOut')
    body = (
      <>
        <Text style={muted}>Sign in with GitHub to follow your pull requests from the relay.</Text>
        {state.notice ? <Text style={[styles.notice, text]}>{state.notice}</Text> : null}
        {button('Sign in with GitHub', relay.start)}
        <Text style={[styles.small, text]}>Relay: {relay.relayUrl}</Text>
        {button('Settings', () => router.push('/settings'), 'secondary')}
      </>
    );
  else if (state.status === 'signingIn') {
    const { step } = state;
    if (step.step === 'starting') body = <ActivityIndicator />;
    else if (step.step === 'code')
      body = (
        <>
          <Text style={muted}>Type this code on GitHub:</Text>
          <Text selectable accessibilityLabel={`Code ${step.userCode}`} style={[styles.code, text]}>
            {step.userCode}
          </Text>
          {button(step.opened ? 'Copy the code and open GitHub again' : 'Copy the code and open GitHub', () => {
            void relay.openGitHub();
          })}
          {step.opened ? (
            <View style={styles.row}>
              <ActivityIndicator />
              <Text style={muted}>Waiting for GitHub…</Text>
            </View>
          ) : null}
          {button('Cancel', relay.cancel, 'secondary')}
        </>
      );
    else if (step.step === 'install')
      body = (
        <>
          <Text style={muted}>The boo App is not installed on any account that you can read.</Text>
          <Text style={[styles.small, text]}>
            An owner of an organization installs it; a member can only request it.
          </Text>
          {button('Install the App on GitHub', relay.openInstall)}
          <View style={styles.row}>
            <ActivityIndicator />
            <Text style={muted}>Waiting for an installation…</Text>
          </View>
          {button('Later', relay.later, 'secondary')}
        </>
      );
    else
      body = (
        <>
          <Text style={[styles.notice, text]}>{step.message}</Text>
          {button('Try again', relay.retry)}
        </>
      );
  } else
    body = (
      <>
        <Text style={muted}>Signed in as</Text>
        <Text style={[styles.login, text]}>{state.connection.login}</Text>
        <Text style={[styles.small, text]}>Relay: {state.connection.url}</Text>
        {state.notice ? <Text style={[styles.notice, text]}>{state.notice}</Text> : null}
        {state.installUrl ? (
          <>
            <Text style={muted}>The boo App is not installed on any account that you can read.</Text>
            {button('Install the App on GitHub', () => relay.install(state.installUrl!))}
            {button('Check again', () => void relay.checkAgain(state.connection), 'secondary')}
          </>
        ) : null}
        {button(
          state.signingOut ? 'Signing out…' : 'Sign out',
          () => void relay.signOut(),
          'secondary',
          state.signingOut,
        )}
        {button('Settings', () => router.push('/settings'), 'secondary', state.signingOut)}
      </>
    );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={styles.body}>
        <Text style={[styles.title, text]}>boo</Text>
        {body}
      </View>
    </SafeAreaView>
  );
}

const colors = {
  light: { background: '#ffffff', text: '#1f2328', accent: '#1f883d', border: '#d1d9e0' },
  dark: { background: '#0d1117', text: '#e6edf3', accent: '#238636', border: '#3d444d' },
};

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  title: { fontSize: 48, fontWeight: '700' },
  muted: { fontSize: 16, textAlign: 'center', opacity: 0.7 },
  small: { fontSize: 13, textAlign: 'center', opacity: 0.6 },
  notice: { fontSize: 15, textAlign: 'center' },
  code: { fontSize: 40, fontWeight: '700', letterSpacing: 4, fontVariant: ['tabular-nums'] },
  login: { fontSize: 24, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { minWidth: 260, minHeight: 48, borderRadius: 10, paddingHorizontal: 20, justifyContent: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
