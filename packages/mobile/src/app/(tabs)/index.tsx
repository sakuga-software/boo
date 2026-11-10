import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ghost, PullList } from '../../pulls/pull-list';
import { useRelayContext } from '../../relay/relay-context';
import { Button } from '../../ui/button';
import { font } from '../../ui/fonts';
import { usePalette } from '../../ui/use-palette';

// The home screen: the sign-in to the relay, then the list of the pull requests.
export default function Home() {
  const palette = usePalette();
  const relay = useRelayContext();
  const router = useRouter();
  const { state } = relay;
  if (state.status === 'signedIn') return <PullList />;

  const text = { color: palette.text };
  const muted = [styles.muted, { color: palette.muted }];
  const button = (label: string, onPress: () => void, kind: 'primary' | 'secondary' = 'primary') => (
    <Button label={label} onPress={onPress} kind={kind} palette={palette} />
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
  else {
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
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={styles.body}>
        <View style={styles.brand}>
          <Ghost palette={palette} size={56} />
          <Text style={[styles.title, text]}>boo</Text>
        </View>
        {body}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  brand: { alignItems: 'center', gap: 4, marginBottom: 8 },
  title: { ...font(700, 44), letterSpacing: -0.9 },
  muted: { ...font(400, 16), textAlign: 'center' },
  small: { ...font(400, 13), textAlign: 'center', opacity: 0.7 },
  notice: { ...font(500, 15), textAlign: 'center' },
  code: { ...font(700, 40), letterSpacing: 4, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
