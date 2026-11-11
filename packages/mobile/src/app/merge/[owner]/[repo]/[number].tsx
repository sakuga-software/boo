import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canMergeIn, mergedDetail, mergePull, type MergeMethod, type MergeResult } from '../../../../pulls/merge';
import { mergeRules } from '../../../../pulls/merge-rules';
import { useMergeToast, type DoneMerge } from '../../../../pulls/merge-toast';
import { usePullsContext } from '../../../../pulls/pulls-context';
import { shortName } from '../../../../pulls/triage';
import { withAbortReason } from '../../../../relay/connection';
import { useRelayContext } from '../../../../relay/relay-context';
import { useInstallations } from '../../../../relay/use-installations';
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
const relayFetch = withAbortReason(fetch);

type Phase = { step: 'ready' } | { step: 'merging' } | { step: 'done'; result: MergeResult };

/**
 * The merge sheet: the rules of the merge, the method and the branch. The relay merges with the GitHub
 * token of the person. If its App has no write permission, the sheet says so and sends the person to GitHub.
 */
export default function MergeSheet() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const relay = useRelayContext();
  const { pulls, refresh } = usePullsContext();
  const { show } = useMergeToast();
  // The toast starts when the sheet closes: the list is under the sheet until then.
  const done = useRef<DoneMerge>(undefined);
  useEffect(
    () => () => {
      if (done.current) show(done.current);
    },
    [show],
  );
  const installations = useInstallations();
  const { owner, repo, number } = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [phase, setPhase] = useState<Phase>({ step: 'ready' });
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const report = pulls.state?.reports.find(
    (item) => item.repo === `${owner}/${repo}` && String(item.number) === number,
  );
  const connection = relay.state.status === 'signedIn' ? relay.state.connection : undefined;
  const github = () => report && void Linking.openURL(report.url);
  const green = palette.tones.green;
  const result = phase.step === 'done' ? phase.result : undefined;
  const noWrite = canMergeIn(installations, owner ?? '') === false || result?.status === 'no-write';
  const locked = phase.step === 'merging';

  const merge = async () => {
    if (!connection || !report?.headSha || noWrite) return;
    setPhase({ step: 'merging' });
    const answer = await mergePull(connection, relayFetch, {
      repo: report.repo,
      number: report.number,
      method,
      deleteBranch,
      sha: report.headSha,
    });
    if (answer.status === 'expired') return void relay.recheck(connection);
    setPhase({ step: 'done', result: answer });
    if (answer.status === 'merged') {
      done.current = { name: shortName(report), branchDeleted: answer.branchDeleted };
      refresh();
    }
  };

  let body: ReactNode;
  if (!report)
    body = (
      <Label size={15} color={palette.muted} lines={3}>
        {`${owner}/${repo}#${number} is no longer in the list of the relay.`}
      </Label>
    );
  else if (result?.status === 'merged')
    body = (
      <View accessibilityRole="alert" style={styles.done}>
        <View
          style={[
            styles.doneMark,
            { backgroundColor: tint(palette.tones.magenta, palette.scheme === 'dark' ? 0.16 : 0.12) },
          ]}
        >
          <Icon name="merged" size={26} color={palette.tones.magenta} />
        </View>
        <View style={styles.titlesCentered}>
          <Label weight={700} size={18} color={palette.text}>
            {`${shortName(report)} merged into ${report.base ?? 'its base'}`}
          </Label>
          <Label size={14} color={palette.muted}>
            {mergedDetail(method, result.branchDeleted)}
          </Label>
        </View>
        <View style={styles.buttons}>
          <BigButton label="View on GitHub" onPress={github} bg={palette.surface2} fg={palette.text2} weight={600} />
          <BigButton
            label="Back to pulls"
            onPress={() => router.dismissTo('/')}
            bg={palette.accent}
            fg={palette.onAccent}
          />
        </View>
      </View>
    );
  else if (result?.status === 'refused' || result?.status === 'failed')
    body = (
      <View accessibilityRole="alert" style={styles.failed}>
        <View style={styles.failedHead}>
          <View
            style={[
              styles.failedMark,
              { backgroundColor: tint(palette.tones.red, palette.scheme === 'dark' ? 0.14 : 0.1) },
            ]}
          >
            <Icon name="x" size={20} color={palette.tones.red} strokeWidth={2.6} />
          </View>
          <View style={styles.grow}>
            <Label weight={700} size={17} color={palette.text}>
              {result.status === 'refused' ? 'GitHub refused the merge' : 'The merge did not go through'}
            </Label>
            <Label size={14} color={palette.muted} lines={3}>
              {result.message}
            </Label>
          </View>
        </View>
        <View style={styles.buttons}>
          <BigButton
            label="Back"
            onPress={() => setPhase({ step: 'ready' })}
            bg={palette.surface2}
            fg={palette.text2}
            weight={600}
            flex={false}
          />
          <BigButton
            label="Open on GitHub"
            icon="external"
            onPress={github}
            bg={palette.accent}
            fg={palette.onAccent}
          />
        </View>
      </View>
    );
  else
    body = (
      <>
        <View style={styles.titles}>
          <Label weight={700} size={18} color={palette.text}>
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
                  style={[styles.ruleMark, { backgroundColor: tint(color, palette.scheme === 'dark' ? 0.16 : 0.12) }]}
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
        {noWrite ? (
          <Notice palette={palette} icon="lock" action={{ label: 'GitHub', onPress: github }}>
            <Label weight={700} size={14} color={palette.noticeText}>
              The relay can't merge yet
            </Label>
            <Label size={13} color={palette.noticeText}>
              Its GitHub App only reads your repos.
            </Label>
          </Notice>
        ) : null}
        <Segmented
          palette={palette}
          label="Merge method"
          options={METHODS}
          value={method}
          onChange={setMethod}
          disabled={locked}
        />
        <View style={styles.switchRow}>
          <Label size={14} color={palette.text} style={styles.grow}>
            Delete the branch after the merge
          </Label>
          <Toggle
            palette={palette}
            label="Delete the branch after the merge"
            value={deleteBranch}
            onChange={setDeleteBranch}
            disabled={locked}
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
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: noWrite || locked, busy: locked }}
              disabled={noWrite || locked}
              onPress={() => void merge()}
              style={({ pressed }) => [
                styles.cta,
                { backgroundColor: noWrite ? palette.disabledBg : palette.accent },
                pressed && styles.pressed,
              ]}
            >
              {locked ? <ActivityIndicator size="small" color={palette.onAccent} /> : null}
              <Label weight={700} size={16} color={noWrite ? palette.disabledFg : palette.onAccent}>
                {locked ? 'Merging…' : CTAS[method]}
              </Label>
            </Pressable>
          </View>
          <Label size={12} color={palette.muted} style={styles.centered}>
            {`Merges on GitHub as ${connection?.login ?? ''}`}
          </Label>
        </View>
      </>
    );

  return (
    <View style={styles.screen}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        disabled={locked}
        onPress={close}
        style={[StyleSheet.absoluteFill, { backgroundColor: palette.overlay }]}
      />
      <View
        accessibilityViewIsModal
        style={[styles.sheet, { backgroundColor: palette.surface, paddingBottom: Math.max(insets.bottom, 16) + 14 }]}
      >
        <View style={[styles.grabber, { backgroundColor: palette.grabber }]} />
        {body}
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
  titlesCentered: { gap: 2, alignItems: 'center' },
  rules: { gap: 8 },
  rule: { minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 10 },
  ruleMark: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  switchRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
  actions: { gap: 8 },
  buttons: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  cta: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  done: { paddingTop: 8, alignItems: 'center', gap: 12 },
  doneMark: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  failed: { gap: 14 },
  failedHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  failedMark: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  centered: { textAlign: 'center' },
  grow: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.6 },
});
