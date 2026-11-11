import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRelayContext } from '../../relay/relay-context';
import { configOf, formOf, unchanged, type SettingsForm } from '../../settings/form';
import { checkRelayUrl } from '../../settings/relay-url';
import { useSettings } from '../../settings/settings-context';
import { Button } from '../../ui/button';
import { font } from '../../ui/fonts';
import { Icon } from '../../ui/icon';
import { Label } from '../../ui/kit';
import { usePalette } from '../../ui/use-palette';

type Field = 'org' | 'authors' | 'repos';

const FIELDS: Record<Field, { title: string; hint: string; placeholder: string; multiline: boolean }> = {
  org: {
    title: 'Organization',
    hint: 'The login of an organization or an account. Empty: every account where the App is installed.',
    placeholder: 'Every account',
    multiline: false,
  },
  authors: {
    title: 'Authors',
    hint: 'One per line: a login, @me for you, or app/<slug> for a GitHub App.',
    placeholder: '@me',
    multiline: true,
  },
  repos: {
    title: 'Repositories',
    hint: 'One per line, as owner/name, or name in the organization. Empty: every repository.',
    placeholder: 'Every repository',
    multiline: true,
  },
};

// The editor of one setting: what the relay follows, or the relay of this phone.
export default function EditSetting() {
  const { field } = useLocalSearchParams<{ field: string }>();
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const relay = useRelayContext();
  const { remote, save } = useSettings();
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/settings'));
  const isRelay = field === 'relay';
  const spec = isRelay ? undefined : FIELDS[field as Field];

  const [draft, setDraft] = useState<SettingsForm>();
  const [relayDraft, setRelayDraft] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;

  const input = (
    value: string,
    onChange: (value: string) => void,
    multiline: boolean,
    placeholder: string,
    label: string,
  ) => (
    <TextInput
      accessibilityLabel={label}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      autoFocus
      value={value}
      onChangeText={(next) => {
        onChange(next);
        setProblem(undefined);
      }}
      multiline={multiline}
      placeholder={placeholder}
      placeholderTextColor={palette.muted}
      keyboardType={isRelay ? 'url' : 'default'}
      editable={!busy}
      style={[
        styles.input,
        font(400, 16),
        multiline && styles.multiline,
        { color: palette.text, backgroundColor: palette.surface, boxShadow: palette.cardShadow },
      ]}
    />
  );

  let title = 'Settings';
  let body;
  if (isRelay) {
    title = 'Relay';
    const value = relayDraft ?? relay.relayUrl;
    const moveTo = async (url: string | undefined) => {
      setBusy(true);
      const result = await relay.changeRelay(url);
      setBusy(false);
      setProblem(result);
      // The home screen has the sign-in on the new relay.
      if (!result) router.replace('/');
    };
    const apply = (text: string) => {
      const checked = checkRelayUrl(text);
      if (checked.error !== undefined) return setProblem(checked.error);
      if (checked.url === relay.relayUrl && (!connection || connection.url === checked.url))
        return setProblem('The app already uses this relay.');
      // The relay of `app.json` is not stored: a new build with another default then takes effect.
      const target = checked.url === relay.defaultRelayUrl ? undefined : checked.url;
      if (!connection) return void moveTo(target);
      Alert.alert('Change the relay?', `You will be signed out of ${connection.url}, then sign in on ${checked.url}.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Change', style: 'destructive', onPress: () => void moveTo(target) },
      ]);
    };
    body = (
      <>
        {input(value, setRelayDraft, false, 'https://', 'Relay URL')}
        <Label size={13} color={palette.muted} lines={4}>
          Your GitHub authorization goes to this relay, which reads your pull requests: use only a relay that you trust.
        </Label>
        {problem ? (
          <Label size={14} color={palette.tones.red} lines={4}>
            {problem}
          </Label>
        ) : null}
        <Button
          label={busy ? 'Checking the relay…' : 'Use this relay'}
          onPress={() => apply(value)}
          palette={palette}
          disabled={busy}
        />
        {relay.relayUrl !== relay.defaultRelayUrl ? (
          <Button
            label="Use the default relay"
            onPress={() => apply(relay.defaultRelayUrl)}
            palette={palette}
            kind="secondary"
            disabled={busy}
          />
        ) : null}
      </>
    );
  } else if (!spec || remote.status !== 'ready') {
    body = (
      <Label size={15} color={palette.muted} lines={3}>
        {spec ? 'Read the settings first: open the Settings tab again.' : 'This setting does not exist.'}
      </Label>
    );
  } else {
    title = spec.title;
    const form = draft ?? formOf(remote.config);
    const key = field as Field;
    const submit = async () => {
      const next = configOf(form, remote.config);
      if (next.error !== undefined) return setProblem(next.error);
      setBusy(true);
      const failed = await save(next.config);
      setBusy(false);
      if (failed) return setProblem(failed);
      leave();
    };
    body = (
      <>
        {input(form[key], (text) => setDraft({ ...form, [key]: text }), spec.multiline, spec.placeholder, spec.title)}
        <Label size={13} color={palette.muted} lines={4}>
          {spec.hint}
        </Label>
        {problem ? (
          <Label size={14} color={palette.tones.red} lines={4}>
            {problem}
          </Label>
        ) : null}
        <Button
          label={busy ? 'Saving…' : 'Save'}
          onPress={() => void submit()}
          palette={palette}
          disabled={busy || unchanged(form, remote.config)}
        />
        <Label size={12} color={palette.muted} lines={3}>
          The settings live on the relay. The CLI and your other phones read them too: the last save wins.
        </Label>
      </>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
          <Pressable accessibilityRole="button" onPress={leave} hitSlop={8} style={styles.back}>
            <Icon name="chevronLeft" size={20} color={palette.accent} />
            <Label size={16} color={palette.accent}>
              Settings
            </Label>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Label weight={700} size={22} color={palette.text} style={styles.title}>
            {title}
          </Label>
          {body}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 8 },
  back: {
    height: 44,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'flex-start',
  },
  content: { paddingHorizontal: 16, paddingBottom: 40, gap: 12, alignItems: 'stretch' },
  title: { letterSpacing: -0.44, marginBottom: 4 },
  input: { borderRadius: 14, paddingHorizontal: 14, minHeight: 48 },
  multiline: { minHeight: 120, paddingTop: 12, textAlignVertical: 'top' },
});
