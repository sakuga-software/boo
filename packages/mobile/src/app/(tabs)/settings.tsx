import type { PushState } from '@sakuga-software/boo-core/settings';
import { pushOn } from '@sakuga-software/boo-core/settings';
import { useRouter, type Href } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePullsContext } from '../../pulls/pulls-context';
import { usePushStatus } from '../../push/push-context';
import { pushLine } from '../../push/status';
import { canMergeIn } from '../../pulls/merge';
import { useRelayContext } from '../../relay/relay-context';
import { useInstallations } from '../../relay/use-installations';
import { useSettings } from '../../settings/settings-context';
import { authorsSummary, hostOf, orgSummary, PUSH_ROWS, reposSummary, withPush } from '../../settings/summary';
import { monogram } from '../../ui/avatars';
import { Icon } from '../../ui/icon';
import type { IconName } from '../../ui/icons';
import { BigButton, Card, divider, GroupTitle, Label, Notice, Toggle, Well } from '../../ui/kit';
import type { Palette } from '../../ui/theme';
import { usePalette } from '../../ui/use-palette';

/** A row of a card of the settings: an icon, a label, a value, and a chevron when it opens a screen. */
function Row({
  palette,
  icon,
  label,
  value,
  valueColor,
  valueWeight = 400,
  index,
  onPress,
}: {
  palette: Palette;
  icon: IconName;
  label: string;
  value?: string;
  valueColor?: string;
  valueWeight?: 400 | 500 | 700;
  index: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}: ${value}` : label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, divider(palette, index), pressed && styles.pressed]}
    >
      <View style={styles.rowIcon}>
        <Icon name={icon} size={17} color={palette.muted} />
      </View>
      <Label size={14} color={palette.text} style={styles.rowLabel}>
        {label}
      </Label>
      <Label weight={valueWeight} size={13} color={valueColor ?? palette.muted} style={styles.rowValue}>
        {value ?? ''}
      </Label>
      <Icon name="chevronRight" size={14} color={palette.muted} />
    </Pressable>
  );
}

function Section({ palette, title, children }: { palette: Palette; title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <GroupTitle palette={palette} title={title} small />
      {children}
    </View>
  );
}

// The settings: the account and its relay, what the relay follows, and the push notifications.
export default function SettingsScreen() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const relay = useRelayContext();
  const { live } = usePullsContext();
  const push = usePushStatus();
  const { remote, retry, save } = useSettings();
  const installations = useInstallations();
  // The merge is on if the App can merge in the organization, or in each account with no organization set.
  const followed =
    remote.status === 'ready' && remote.config.org
      ? [remote.config.org]
      : (installations ?? []).map(({ account }) => account);
  const canMerge = followed.length > 0 && followed.every((account) => canMergeIn(installations, account) === true);
  const [problem, setProblem] = useState<string>();
  const { state } = relay;
  const signedIn = state.status === 'signedIn' ? state : undefined;
  const edit = (field: 'org' | 'authors' | 'repos' | 'relay') =>
    router.push({ pathname: '/edit/[field]', params: { field } } as unknown as Href);

  const relayValue = relay.relayUrl === relay.defaultRelayUrl ? 'default' : hostOf(relay.relayUrl);
  const liveWords = live === 'live' ? 'live' : 'polling';

  const account = (
    <Section palette={palette} title="Account">
      <Card palette={palette}>
        {signedIn ? (
          <View style={styles.identity}>
            <View style={[styles.avatar, { backgroundColor: palette.avatarBg }]}>
              <Label weight={700} size={12} color={palette.avatarFg}>
                {monogram(signedIn.connection.login).toUpperCase()}
              </Label>
            </View>
            <View style={styles.grow}>
              <Label weight={600} size={15} color={palette.text}>
                {signedIn.connection.login}
              </Label>
              <View style={styles.liveLine}>
                <View
                  style={[
                    styles.liveDot,
                    { backgroundColor: live === 'live' ? palette.tones.green : palette.tones.yellow },
                  ]}
                />
                <Label size={13} color={palette.muted} style={styles.shrink}>
                  {`${liveWords} on ${hostOf(signedIn.connection.url)}`}
                </Label>
              </View>
            </View>
          </View>
        ) : null}
        <Row
          palette={palette}
          index={signedIn ? 1 : 0}
          icon="shield"
          label="Relay"
          value={relayValue}
          onPress={() => edit('relay')}
        />
        {signedIn ? (
          <Row
            palette={palette}
            index={2}
            icon="lock"
            label="Merge from the phone"
            value={canMerge ? 'on' : 'read only'}
            valueColor={canMerge ? palette.tones.green : palette.tones.yellow}
            valueWeight={700}
            onPress={() =>
              Alert.alert(
                'Merge from the phone',
                canMerge
                  ? 'The relay merges with your GitHub account: GitHub shows you as the author of the merge, and your rights apply.'
                  : 'The GitHub App of the relay only reads your repositories. An owner gives it write access to Contents and Pull requests, then the Merge sheet merges.',
              )
            }
          />
        ) : null}
        {signedIn?.installUrl ? (
          <Row
            palette={palette}
            index={3}
            icon="building"
            label="Install the App"
            value="not installed"
            valueColor={palette.tones.yellow}
            valueWeight={700}
            onPress={() => relay.install(signedIn.installUrl!)}
          />
        ) : null}
      </Card>
      {signedIn?.notice ? (
        <Label size={13} color={palette.muted} lines={3} style={styles.footnote}>
          {signedIn.notice}
        </Label>
      ) : null}
    </Section>
  );

  let follows: ReactNode = null;
  let notify: ReactNode = null;
  if (signedIn) {
    if (remote.status === 'ready') {
      const { config } = remote;
      const denied = push.status === 'denied';
      const toggle = async (key: PushState, on: boolean) => {
        setProblem(await save(withPush(config, key, on)));
      };
      follows = (
        <Section palette={palette} title="What the relay follows">
          <Card palette={palette}>
            <Row
              palette={palette}
              index={0}
              icon="building"
              label="Organization"
              value={orgSummary(config.org)}
              onPress={() => edit('org')}
            />
            <Row
              palette={palette}
              index={1}
              icon="people"
              label="Authors"
              value={authorsSummary(config.settings.authors)}
              onPress={() => edit('authors')}
            />
            <Row
              palette={palette}
              index={2}
              icon="repo"
              label="Repositories"
              value={reposSummary(config.settings.repos, config.org)}
              onPress={() => edit('repos')}
            />
          </Card>
          <Label size={12} color={palette.muted} style={styles.footnote}>
            The CLI and your other phones read the same settings.
          </Label>
        </Section>
      );
      notify = (
        <Section palette={palette} title="Notify me when a pull request">
          {denied ? (
            <Notice
              palette={palette}
              icon="bellOff"
              action={{ label: 'Open Settings', onPress: () => void Linking.openSettings() }}
            >
              <Label size={13} color={palette.noticeText}>
                iOS blocks the notifications of boo
              </Label>
            </Notice>
          ) : null}
          <Card palette={palette} style={denied && styles.dimmed}>
            {PUSH_ROWS.map((row, index) => {
              const on = !denied && pushOn(config.settings, row.key);
              return (
                <View key={row.key} style={[styles.pushRow, divider(palette, index)]}>
                  <Well
                    palette={palette}
                    icon={row.icon}
                    color={palette.tones[row.tone]}
                    size={26}
                    iconSize={14}
                    strokeWidth={2.6}
                  />
                  <Label size={14} color={palette.text} style={styles.grow}>
                    {row.label}
                  </Label>
                  <Toggle
                    palette={palette}
                    label={`Notify me when a pull request ${row.label}`}
                    value={on}
                    disabled={denied || remote.saving}
                    onChange={(next) => void toggle(row.key, next)}
                  />
                </View>
              );
            })}
          </Card>
          {push.status !== 'registered' && !denied ? (
            <Label size={12} color={palette.muted} lines={3} style={styles.footnote}>
              {pushLine(push)}
            </Label>
          ) : null}
          {(problem ?? remote.error) ? (
            <Label size={13} color={palette.tones.red} lines={3} style={styles.footnote}>
              {problem ?? remote.error}
            </Label>
          ) : null}
        </Section>
      );
    } else if (remote.status === 'failed')
      follows = (
        <Section palette={palette} title="What the relay follows">
          <Notice palette={palette} action={{ label: 'Try again', onPress: retry }}>
            <Label size={13} color={palette.noticeText} lines={3}>
              {remote.message}
            </Label>
          </Notice>
        </Section>
      );
    else follows = <ActivityIndicator accessibilityLabel="Reading the settings" color={palette.muted} />;
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        {signedIn ? null : (
          <Pressable accessibilityRole="button" onPress={() => router.navigate('/')} hitSlop={8} style={styles.back}>
            <Icon name="chevronLeft" size={20} color={palette.accent} />
            <Label size={16} color={palette.accent}>
              Sign in
            </Label>
          </Pressable>
        )}
        <Label weight={700} size={22} color={palette.text} style={styles.title}>
          Settings
        </Label>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {account}
        {follows}
        {notify}
        {signedIn ? (
          <BigButton
            label={signedIn.signingOut ? 'Signing out…' : 'Sign out'}
            onPress={() => void relay.signOut()}
            disabled={signedIn.signingOut}
            bg={palette.surface}
            fg={palette.tones.red}
            weight={600}
            flex={false}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 10 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 44, marginLeft: -6 },
  title: { minHeight: 44, lineHeight: 44, letterSpacing: -0.44 },
  content: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 20, gap: 16 },
  section: { gap: 6 },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 14,
  },
  avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  liveLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  row: { minHeight: 44, paddingLeft: 12, paddingRight: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowIcon: { width: 24, alignItems: 'center' },
  rowLabel: { flexShrink: 0 },
  rowValue: { flex: 1, textAlign: 'right' },
  pushRow: {
    minHeight: 46,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  footnote: { paddingHorizontal: 4 },
  dimmed: { opacity: 0.5 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
