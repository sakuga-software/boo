import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mergeRules } from '../../../../pulls/merge-rules';
import { usePullsContext } from '../../../../pulls/pulls-context';
import { shortName } from '../../../../pulls/triage';
import { useRelayContext } from '../../../../relay/relay-context';
import { accountAvatar } from '../../../../ui/avatars';
import { Icon } from '../../../../ui/icon';
import { AvatarBadge, BigButton, Label, Notice, Pips, Segmented, Toggle } from '../../../../ui/kit';
import { tint } from '../../../../ui/theme';
import { usePalette } from '../../../../ui/use-palette';

const METHODS = [
  { id: 'squash', label: 'Squash' },
  { id: 'merge', label: 'Merge' },
  { id: 'rebase', label: 'Rebase' },
] as const;
const CTAS = { squash: 'Squash and merge', merge: 'Merge commit', rebase: 'Rebase and merge' } as const;

/**
 * The merge sheet: the rules of the merge, the method and the branch. The GitHub App of the relay only
 * reads the repositories, so the sheet says it and sends the merge to GitHub.
 */
export default function MergeSheet() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const relay = useRelayContext();
  const { pulls } = usePullsContext();
  const { owner, repo, number } = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const [method, setMethod] = useState<(typeof METHODS)[number]['id']>('squash');
  const [deleteBranch, setDeleteBranch] = useState(true);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const report = pulls.state?.reports.find(
    (item) => item.repo === `${owner}/${repo}` && String(item.number) === number,
  );
  const login = relay.state.status === 'signedIn' ? relay.state.connection.login : '';
  const github = () => report && void Linking.openURL(report.url);
  const green = palette.tones.green;

  return (
    <View style={styles.screen}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={close}
        style={[StyleSheet.absoluteFill, { backgroundColor: palette.overlay }]}
      />
      <View
        accessibilityViewIsModal
        style={[styles.sheet, { backgroundColor: palette.surface, paddingBottom: Math.max(insets.bottom, 16) + 14 }]}
      >
        <View style={[styles.grabber, { backgroundColor: palette.grabber }]} />
        {!report ? (
          <Label size={15} color={palette.muted} lines={3}>
            {`${owner}/${repo}#${number} is no longer in the list of the relay.`}
          </Label>
        ) : (
          <>
            <View style={styles.titles}>
              <Label weight={700} size={18} color={palette.text} accessibilityLabel={`Merge ${shortName(report)}`}>
                {`Merge ${shortName(report)}`}
              </Label>
              <Label size={14} color={palette.muted}>
                {report.title}
              </Label>
            </View>
            <View accessibilityLabel="Merge policy" style={styles.rules}>
              {mergeRules(report).map((rule) => {
                const color = rule.ok ? green : palette.tones.red;
                return (
                  <View key={rule.label} style={styles.rule}>
                    <View
                      style={[
                        styles.ruleMark,
                        { backgroundColor: tint(color, palette.scheme === 'dark' ? 0.16 : 0.12) },
                      ]}
                    >
                      <Icon name={rule.ok ? 'check' : 'x'} size={12} color={color} strokeWidth={3.2} />
                    </View>
                    <Label size={14} color={palette.text} style={styles.grow}>
                      {rule.label}
                    </Label>
                    {rule.score ? (
                      <Pips palette={palette} score={rule.score.score} total={rule.score.total} color={green} />
                    ) : null}
                    {rule.approver ? (
                      <AvatarBadge palette={palette} avatar={accountAvatar(rule.approver, palette.scheme)} size={20} />
                    ) : null}
                    {rule.value ? (
                      <Label size={13} color={palette.muted}>
                        {rule.value}
                      </Label>
                    ) : null}
                  </View>
                );
              })}
            </View>
            {report.stack.parent ? (
              <Notice palette={palette} icon="stack">
                <Label size={13} color={palette.noticeText}>
                  {`Stacked: lands in ${report.base ?? 'its parent'}, not the default branch`}
                </Label>
              </Notice>
            ) : null}
            <Notice palette={palette} icon="lock" action={{ label: 'GitHub', onPress: github }}>
              <Label weight={700} size={14} color={palette.noticeText}>
                The relay can't merge yet
              </Label>
              <Label size={13} color={palette.noticeText}>
                Its GitHub App only reads your repos.
              </Label>
            </Notice>
            <Segmented palette={palette} label="Merge method" options={METHODS} value={method} onChange={setMethod} />
            <View style={styles.switchRow}>
              <Label size={14} color={palette.text} style={styles.grow}>
                Delete the branch after the merge
              </Label>
              <Toggle
                palette={palette}
                label="Delete the branch after the merge"
                value={deleteBranch}
                onChange={setDeleteBranch}
              />
            </View>
            <View style={styles.actions}>
              <View style={styles.buttons}>
                <BigButton
                  label="Cancel"
                  onPress={close}
                  bg={palette.surface2}
                  fg={palette.text2}
                  weight={600}
                  flex={false}
                />
                <BigButton
                  label={CTAS[method]}
                  onPress={() => {}}
                  disabled
                  bg={palette.disabledBg}
                  fg={palette.disabledFg}
                  size={16}
                />
              </View>
              <Label size={12} color={palette.muted} style={styles.centered}>
                {`Merges on GitHub as ${login}`}
              </Label>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    paddingTop: 6,
    paddingHorizontal: 16,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    gap: 14,
    boxShadow: '0 -12px 40px rgba(10,6,20,0.3)',
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3 },
  titles: { gap: 2 },
  rules: { gap: 8 },
  rule: { minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 10 },
  ruleMark: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  switchRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  actions: { gap: 8 },
  buttons: { flexDirection: 'row', gap: 8 },
  centered: { textAlign: 'center' },
  grow: { flex: 1, minWidth: 0 },
});
