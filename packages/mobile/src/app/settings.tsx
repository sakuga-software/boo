import type { RelayConnection } from '@sakuga-software/boo-core/relay';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRelayContext } from '../relay/relay-context';
import { Button } from '../ui/button';
import { usePalette } from '../ui/use-palette';
import { configOf, formOf, unchanged, type SettingsForm } from '../settings/form';
import { checkRelayUrl } from '../settings/relay-url';
import { readSettings, writeSettings, type WatchConfig } from '../settings/remote';

type Remote =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; config: WatchConfig; form: SettingsForm; saving?: boolean; message?: string; error?: string };

// The settings: the relay of this phone, and what the relay follows for the user (D6: on the relay,
// the last write wins).
export default function SettingsScreen() {
  const palette = usePalette();
  const relay = useRelayContext();
  const router = useRouter();
  const { state } = relay;
  const connection = state.status === 'signedIn' ? state.connection : undefined;
  const text = { color: palette.text };
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // What the person typed in the relay field. `undefined`: the relay of the app.
  const [relayEdit, setRelayEdit] = useState<string>();
  const relayInput = relayEdit ?? relay.relayUrl;
  const [relayProblem, setRelayProblem] = useState<string>();
  const [moving, setMoving] = useState(false);

  // Each read of the settings has a key: a read of another session, or an older attempt, shows as loading.
  const [attempt, setAttempt] = useState(0);
  const readKey = connection ? `${connection.url} ${connection.session} ${attempt}` : '';
  const [stored, setRemote] = useState<Remote & { read: string }>({ status: 'loading', read: '' });
  const remote: Remote = stored.read === readKey ? stored : { status: 'loading' };
  const { recheck } = relay;
  useEffect(() => {
    if (!connection) return;
    let current = true;
    void readSettings(connection, fetch).then((result) => {
      if (!current) return;
      if (result.status === 'ok')
        setRemote({ status: 'ready', config: result.config, form: formOf(result.config), read: readKey });
      // The relay no longer knows the session: the check of the session signs out.
      else if (result.status === 'expired') void recheck(connection);
      else setRemote({ status: 'failed', message: result.message, read: readKey });
    });
    return () => {
      current = false;
    };
  }, [connection, readKey, recheck]);

  const button = (label: string, onPress: () => void, kind: 'primary' | 'secondary' = 'primary', disabled = false) => (
    <Button label={label} onPress={onPress} kind={kind} palette={palette} disabled={disabled} />
  );

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    hint: string,
    options: { multiline?: boolean; placeholder?: string; keyboardType?: 'url'; editable?: boolean } = {},
  ) => (
    <View style={styles.field}>
      <Text style={[styles.label, text]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        value={value}
        onChangeText={onChange}
        multiline={options.multiline}
        placeholder={options.placeholder}
        placeholderTextColor={palette.muted}
        keyboardType={options.keyboardType}
        editable={options.editable ?? true}
        style={[
          styles.input,
          options.multiline && styles.multiline,
          { color: palette.text, borderColor: palette.border, backgroundColor: palette.surface },
        ]}
      />
      <Text style={[styles.hint, text]}>{hint}</Text>
    </View>
  );

  const moveTo = async (url: string | undefined) => {
    setMoving(true);
    const problem = await relay.changeRelay(url);
    setMoving(false);
    setRelayProblem(problem);
    if (problem) return;
    setRelayEdit(undefined);
    // The home screen has the sign-in on the new relay (the account screen sends a signed-out person there).
    leave();
  };

  const applyRelay = (input: string) => {
    const checked = checkRelayUrl(input);
    if (checked.error !== undefined) return setRelayProblem(checked.error);
    setRelayProblem(undefined);
    if (checked.url === relay.relayUrl && (!connection || connection.url === checked.url))
      return setRelayProblem('The app already uses this relay.');
    // The relay of `app.json` is not stored: a new build with another default then takes effect.
    const target = checked.url === relay.defaultRelayUrl ? undefined : checked.url;
    if (!connection) return void moveTo(target);
    Alert.alert('Change the relay?', `You will be signed out of ${connection.url}, then sign in on ${checked.url}.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Change', style: 'destructive', onPress: () => void moveTo(target) },
    ]);
  };

  const save = async (current: RelayConnection, ready: Extract<Remote, { status: 'ready' }>) => {
    const next = configOf(ready.form, ready.config);
    const read = readKey;
    if (next.error !== undefined) return setRemote({ ...ready, error: next.error, message: undefined, read });
    setRemote({ ...ready, saving: true, error: undefined, message: undefined, read });
    const result = await writeSettings(current, fetch, next.config);
    if (result.status === 'expired') return void recheck(current);
    setRemote((now) => {
      if (now.status !== 'ready' || now.read !== read) return now;
      if (result.status === 'failed') return { ...now, saving: false, error: result.message };
      // The relay gives back what it keeps: the repositories with their owner.
      return {
        status: 'ready',
        config: result.config,
        form: formOf(result.config),
        message: 'Saved. The relay reads the list of pull requests again.',
        read,
      };
    });
  };

  let follows: ReactNode;
  if (state.status === 'loading' || state.status === 'signingIn') follows = <ActivityIndicator />;
  else if (!connection) follows = <Text style={[styles.muted, text]}>Sign in to choose what the relay follows.</Text>;
  else if (remote.status === 'loading') follows = <ActivityIndicator accessibilityLabel="Reading the settings" />;
  else if (remote.status === 'failed')
    follows = (
      <>
        <Text style={[styles.notice, text]}>{remote.message}</Text>
        {button('Try again', () => setAttempt((count) => count + 1), 'secondary')}
      </>
    );
  else {
    const edit = (change: Partial<SettingsForm>) =>
      setRemote({
        ...remote,
        form: { ...remote.form, ...change },
        message: undefined,
        error: undefined,
        read: readKey,
      });
    follows = (
      <>
        {field(
          'Organization',
          remote.form.org,
          (org) => edit({ org }),
          'The login of an organization or an account. Empty: every account where the App is installed.',
          { placeholder: 'Every account', editable: !remote.saving },
        )}
        {field(
          'Authors',
          remote.form.authors,
          (authors) => edit({ authors }),
          'One per line: a login, @me for you, or app/<slug> for a GitHub App.',
          { multiline: true, placeholder: '@me', editable: !remote.saving },
        )}
        {field(
          'Repositories',
          remote.form.repos,
          (repos) => edit({ repos }),
          'One per line, as owner/name, or name in the organization. Empty: every repository.',
          { multiline: true, placeholder: 'Every repository', editable: !remote.saving },
        )}
        {remote.error ? <Text style={[styles.notice, { color: palette.tones.red }]}>{remote.error}</Text> : null}
        {remote.message ? <Text style={[styles.notice, text]}>{remote.message}</Text> : null}
        {button(
          remote.saving ? 'Saving…' : 'Save',
          () => void save(connection, remote),
          'primary',
          remote.saving || unchanged(remote.form, remote.config),
        )}
        <Text style={[styles.hint, text]}>
          The settings live on the relay. The CLI and your other phones read them too: the last save wins.
        </Text>
      </>
    );
  }

  const otherRelay = relay.relayUrl !== relay.defaultRelayUrl;
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.background }]}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={leave} hitSlop={12}>
            <Text style={[styles.back, { color: palette.tones.blue }]}>‹ Back</Text>
          </Pressable>
          <Text style={[styles.title, text]}>Settings</Text>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.section, text]}>Relay</Text>
          {field(
            'Relay URL',
            relayInput,
            (value) => {
              setRelayEdit(value);
              setRelayProblem(undefined);
            },
            'Your GitHub authorization goes to this relay, which reads your pull requests: use only a relay that you trust.',
            { keyboardType: 'url', editable: !moving },
          )}
          {relayProblem ? <Text style={[styles.notice, { color: palette.tones.red }]}>{relayProblem}</Text> : null}
          {button(moving ? 'Checking the relay…' : 'Use this relay', () => applyRelay(relayInput), 'primary', moving)}
          {otherRelay
            ? button('Use the default relay', () => applyRelay(relay.defaultRelayUrl), 'secondary', moving)
            : null}

          <Text style={[styles.section, text]}>What the relay follows</Text>
          {follows}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 12 },
  back: { fontSize: 17, fontWeight: '600' },
  title: { fontSize: 24, fontWeight: '700' },
  body: { gap: 14, padding: 20, paddingBottom: 48 },
  section: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    opacity: 0.7,
    marginTop: 8,
  },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, minHeight: 44, fontSize: 16 },
  multiline: { minHeight: 88, paddingTop: 10, textAlignVertical: 'top' },
  hint: { fontSize: 13, opacity: 0.6 },
  muted: { fontSize: 15, opacity: 0.7 },
  notice: { fontSize: 15 },
});
