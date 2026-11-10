import { agentName } from '@sakuga-software/boo-core/agents';
import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { blockersOf, mainAction, targetUrl, type Blocker, type Target } from '../../../../pulls/blockers';
import { detailSections } from '../../../../pulls/detail';
import { usePullsContext } from '../../../../pulls/pulls-context';
import { failedChecks, headTime, reviewerGlyph, reviewerWords, shortName, stateGlyph } from '../../../../pulls/triage';
import { useRelayContext } from '../../../../relay/relay-context';
import { accountAvatar, agentAvatar } from '../../../../ui/avatars';
import { Icon } from '../../../../ui/icon';
import { AvatarBadge, BigButton, Card, divider, GroupTitle, Label, Pill, Pips, Well } from '../../../../ui/kit';
import { tint, well, type Palette } from '../../../../ui/theme';
import { formatTime, shortAgo } from '../../../../ui/time';
import { useNow } from '../../../../ui/use-now';
import { usePalette } from '../../../../ui/use-palette';

const toneOf = (palette: Palette, tone: Blocker['tone']) => (tone === 'claude' ? palette.claude : palette.tones[tone]);

/** A chip of the head: an icon and a word on a tint of their color. */
function Chip({
  palette,
  color,
  icon,
  label,
}: {
  palette: Palette;
  color: string;
  icon: Blocker['icon'];
  label: string;
}) {
  return (
    <View style={[styles.chip, { backgroundColor: well(palette, color) }]}>
      <Icon name={icon} size={14} color={color} strokeWidth={2.6} />
      <Label weight={600} size={13} color={color}>
        {label}
      </Label>
    </View>
  );
}

function Section({
  palette,
  title,
  count,
  countColor,
  countWeight,
  children,
}: {
  palette: Palette;
  title: string;
  count?: string;
  countColor?: string;
  countWeight?: 500 | 700;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <GroupTitle palette={palette} title={title} count={count} countColor={countColor} countWeight={countWeight} />
      {children}
    </View>
  );
}

const SUB_AGENT_TONES = { working: 'cyan', done: 'green', failed: 'red', stopped: 'gray' } as const;
const SESSION_TONES = { working: 'cyan', waiting: 'yellow', idle: 'gray', none: 'gray' } as const;

function AgentCard({ report, palette }: { report: PullRequestReport; palette: Palette }) {
  const { agent } = report;
  if (!agent.kind) return null;
  const avatar = agentAvatar(agent.kind, palette.scheme, palette.claude, well(palette, palette.claude, true));
  const sub = agent.subAgent;
  let status: string | undefined = sub?.state;
  if (!sub && agent.sessionState !== 'none') status = agent.sessionState;
  const statusTone = sub ? SUB_AGENT_TONES[sub.state] : SESSION_TONES[agent.sessionState];
  let where = 'on a computer of the team';
  if (agent.cloudSession) where = 'cloud session';
  else if (sub) where = `sub-agent of ${agentName(agent.kind)}`;
  return (
    <Section palette={palette} title="Agent">
      <Card palette={palette} style={styles.agent}>
        <AvatarBadge palette={palette} avatar={avatar} size={30} />
        <View style={styles.grow}>
          <Label weight={600} size={14} color={palette.text}>
            {sub?.description ?? avatar.name}
          </Label>
          <View style={styles.inline}>
            <Icon name="laptop" size={13} color={palette.muted} />
            <Label size={13} color={palette.muted} style={styles.shrink}>
              {where}
            </Label>
          </View>
        </View>
        {status ? (
          <View style={[styles.status, { backgroundColor: well(palette, palette.tones[statusTone]) }]}>
            <Label weight={700} size={12} color={palette.tones[statusTone]}>
              {status}
            </Label>
          </View>
        ) : null}
      </Card>
    </Section>
  );
}

function Reviewers({ report, palette, now }: { report: PullRequestReport; palette: Palette; now: Date }) {
  const { reviewers } = report;
  if (reviewers.length === 0) return null;
  const onHead = reviewers.filter((reviewer) => reviewer.onHead).length;
  const back = report.notes.coderabbit?.kind === 'wait' ? new Date(report.notes.coderabbit.availableAt) : undefined;
  return (
    <Section
      palette={palette}
      title="Reviewers"
      count={`${onHead} of ${reviewers.length} on the last commit`}
      countWeight={500}
    >
      <Card palette={palette}>
        {reviewers.map((reviewer, index) => {
          const glyph = reviewerGlyph(reviewer.mark);
          const color = palette.tones[glyph.tone];
          const avatar = accountAvatar(reviewer.login, palette.scheme);
          let words = reviewerWords(reviewer.mark);
          if (reviewer.mark === 'stale') words = 'older commit only';
          if (reviewer.mark === 'quota' && back && /coderabbit/i.test(reviewer.login))
            words = `out of quota · back ${formatTime(back)}`;
          const score = reviewer.score;
          const scoreColor = score && score.score / score.total >= 0.8 ? palette.tones.green : palette.tones.yellow;
          return (
            <View key={`${index}:${reviewer.login}`} style={[styles.reviewer, divider(palette, index)]}>
              <AvatarBadge palette={palette} avatar={avatar} size={28} badge={{ icon: glyph.icon, color }} />
              <View style={styles.grow}>
                <Label weight={600} size={14} color={palette.text}>
                  {avatar.name}
                </Label>
                <Label size={13} color={color}>
                  {words}
                </Label>
              </View>
              {score ? (
                <View style={styles.inline} accessibilityLabel={`Score ${score.score} out of ${score.total}`}>
                  <Pips palette={palette} score={score.score} total={score.total} color={scoreColor} />
                  <Label weight={700} size={13} color={scoreColor}>
                    {`${score.score}/${score.total}`}
                  </Label>
                </View>
              ) : null}
              <Label size={12} color={palette.muted} style={styles.ago}>
                {reviewer.at ? shortAgo(now, new Date(reviewer.at)) : ''}
              </Label>
            </View>
          );
        })}
      </Card>
    </Section>
  );
}

function Checks({ report, palette, onOpen }: { report: PullRequestReport; palette: Palette; onOpen: () => void }) {
  const { checks } = report;
  const failed = failedChecks(checks);
  const segments = [
    ...Array<string>(checks.passed).fill(palette.tones.green),
    ...Array<string>(failed.length).fill(palette.tones.red),
    ...Array<string>(checks.reviewerErrors.length).fill(palette.tones.yellow),
    ...Array<string>(checks.running).fill(tint(palette.tones.yellow, 0.5)),
    ...Array<string>(checks.skipped + checks.quota).fill(palette.pipOff),
  ];
  if (segments.length === 0) return null;
  const spoken = [
    `${checks.passed} checks passed`,
    failed.length && `${failed.length} failing`,
    checks.running && `${checks.running} running`,
  ]
    .filter(Boolean)
    .join(', ');
  const lines: { icon: Blocker['icon']; color: string; name: string; note: string }[] = [
    ...failed.map((name) => ({ icon: 'x' as const, color: palette.tones.red, name, note: 'failing' })),
    ...checks.reviewerErrors.map(({ check }) => ({
      icon: 'warn' as const,
      color: palette.tones.yellow,
      name: check,
      note: 'bot failed',
    })),
  ];
  if (checks.running > 0)
    lines.push({ icon: 'reviewing', color: palette.tones.yellow, name: `${checks.running} running`, note: '' });
  return (
    <Section palette={palette} title="Checks">
      <Card palette={palette} style={styles.checks}>
        <View accessibilityRole="image" accessibilityLabel={spoken} style={styles.segments}>
          {segments.map((color, index) => (
            <View key={index} style={[styles.segment, { backgroundColor: color }]} />
          ))}
        </View>
        {lines.map((line, index) => (
          <View key={`${index}:${line.name}`} style={[styles.checkLine, divider(palette, index)]}>
            <Icon name={line.icon} size={16} color={line.color} strokeWidth={2.6} />
            <Label size={14} color={palette.text} style={styles.grow}>
              {line.name}
            </Label>
            <Label size={13} color={palette.muted}>
              {line.note}
            </Label>
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens the checks on GitHub"
          onPress={onOpen}
          style={({ pressed }) => [styles.checkLine, divider(palette, lines.length), pressed && styles.pressed]}
        >
          <Icon name="check" size={16} color={palette.tones.green} strokeWidth={2.6} />
          <Label size={14} color={palette.text} style={styles.grow}>
            {`${checks.passed} passed`}
          </Label>
          <Icon name="chevronRight" size={14} color={palette.muted} />
        </Pressable>
      </Card>
    </Section>
  );
}

// The details of one pull request: what blocks its merge, its agent, its reviewers and its checks.
export default function PullDetail() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const relay = useRelayContext();
  const { pulls, refresh } = usePullsContext();
  const { owner, repo, number } = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const [failedToOpen, setFailedToOpen] = useState<string>();
  const now = useNow();
  if (relay.state.status !== 'signedIn') return <Redirect href="/" />;

  const reports = pulls.state?.reports ?? [];
  const report = reports.find((item) => item.repo === `${owner}/${repo}` && String(item.number) === number);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const openUrl = (url: string) =>
    void Linking.openURL(url).then(
      () => setFailedToOpen(undefined),
      () => setFailedToOpen(url),
    );
  const open = (target: Target) => report && openUrl(targetUrl(report, target));

  let body: ReactNode;
  let bar: ReactNode = null;
  if (!report || !pulls.state)
    body = (
      <Label size={16} color={palette.text} lines={3} style={styles.missing}>
        {`${owner}/${repo}#${number} is no longer in the list of the relay.`}
      </Label>
    );
  else {
    const at = new Date(pulls.state.at);
    const glyph = stateGlyph(report);
    const tone = palette.tones[glyph.tone];
    const blockers = blockersOf(report, reports);
    const head = headTime(report, at);
    const changes = report.changes ?? null;
    const left = report.state === 'merged' || report.state === 'closed';
    const notes = detailSections(report, reports, at, now).filter(
      ({ label }) => label === 'notes' || label === 'merged',
    );
    const main = mainAction(blockers);
    body = (
      <>
        <View style={styles.head}>
          <View style={styles.chips}>
            <Chip palette={palette} color={tone} icon={glyph.icon} label={report.state} />
            {report.stalled ? <Chip palette={palette} color={palette.tones.yellow} icon="zz" label="stalled" /> : null}
            {report.stale ? <Chip palette={palette} color={palette.tones.gray} icon="stale" label="stale" /> : null}
          </View>
          <Label weight={600} size={20} color={palette.text} lines={2} style={styles.title}>
            {report.title || 'No title'}
          </Label>
          <View style={styles.meta}>
            <Label size={13} color={palette.muted} style={styles.shrink}>
              {`${shortName(report)}${report.base ? ` → ${report.base}` : ''}`}
              {changes ? (
                <>
                  {' · '}
                  <Label weight={600} size={13} color={palette.tones.green}>{`+${changes.additions}`}</Label>{' '}
                  <Label weight={600} size={13} color={palette.tones.red}>{`−${changes.deletions}`}</Label>
                  {' ·'}
                </>
              ) : null}
            </Label>
            {changes ? <Icon name="file" size={13} color={palette.muted} /> : null}
            <Label size={13} color={palette.muted} style={styles.shrink}>
              {[
                changes && `${changes.files} file${changes.files === 1 ? '' : 's'}`,
                head && `last commit ${shortAgo(now, head)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Label>
          </View>
        </View>
        {blockers.length > 0 ? (
          <Section
            palette={palette}
            title="What blocks the merge"
            count={String(blockers.length)}
            countColor={palette.tones.red}
          >
            <Card palette={palette}>
              {blockers.map((blocker, index) => {
                const color = toneOf(palette, blocker.tone);
                return (
                  <View key={`${index}:${blocker.what}`} style={[styles.blocker, divider(palette, index)]}>
                    <Well palette={palette} icon={blocker.icon} color={color} />
                    <View style={[styles.grow, styles.blockerText]}>
                      <Label weight={600} size={14} color={palette.text}>
                        {blocker.what}
                      </Label>
                      <Label size={13} color={palette.muted}>
                        {blocker.why}
                      </Label>
                    </View>
                    {blocker.action ? (
                      <Pill
                        label={blocker.action.label}
                        icon={blocker.action.icon}
                        accessibilityLabel={`${blocker.action.label}: ${blocker.what}, on GitHub`}
                        onPress={() => open(blocker.action!.target)}
                        bg={tint(palette.accent, palette.scheme === 'dark' ? 0.16 : 0.1)}
                        fg={palette.accentText}
                      />
                    ) : null}
                  </View>
                );
              })}
            </Card>
          </Section>
        ) : null}
        <AgentCard report={report} palette={palette} />
        {left || report.error ? null : <Reviewers report={report} palette={palette} now={now} />}
        {left || report.error ? null : <Checks report={report} palette={palette} onOpen={() => open('checks')} />}
        {notes.length > 0 ? (
          <Section palette={palette} title="Notes">
            <Card palette={palette} style={styles.notes}>
              {notes
                .flatMap(({ lines }) => lines)
                .map((line, index) => (
                  <Label key={index} size={13} color={palette.muted} lines={4}>
                    {line.map(({ text }) => text).join('')}
                  </Label>
                ))}
            </Card>
          </Section>
        ) : null}
        {failedToOpen ? (
          <Label size={13} color={palette.tones.red} lines={3}>
            {`The phone could not open ${failedToOpen}.`}
          </Label>
        ) : null}
      </>
    );
    const merge = () =>
      router.push({
        pathname: '/merge/[owner]/[repo]/[number]',
        params: { owner: owner!, repo: repo!, number: number! },
      });
    let buttons: ReactNode;
    if (left)
      buttons = (
        <BigButton
          label="View on GitHub"
          icon="external"
          onPress={() => open('pull')}
          bg={palette.accent}
          fg={palette.onAccent}
        />
      );
    else if (report.state === 'ready to merge')
      buttons = <BigButton label="Merge" onPress={merge} bg={palette.accent} fg={palette.onAccent} size={16} />;
    else
      buttons = (
        <>
          <BigButton
            label="Merge blocked"
            icon="lock"
            onPress={() => {}}
            disabled
            bg={palette.disabledBg}
            fg={palette.disabledFg}
            weight={600}
          />
          <BigButton
            label={main?.label ?? 'Open on GitHub'}
            icon={main?.icon ?? 'external'}
            onPress={() => open(main?.target ?? 'pull')}
            bg={palette.accent}
            fg={palette.onAccent}
          />
        </>
      );
    bar = (
      <View
        style={[
          styles.bar,
          { paddingBottom: Math.max(insets.bottom, 12), backgroundColor: palette.bar, borderTopColor: palette.barLine },
        ]}
      >
        {buttons}
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <Pressable accessibilityRole="button" onPress={back} hitSlop={8} style={styles.back}>
          <Icon name="chevronLeft" size={20} color={palette.accent} />
          <Label size={16} color={palette.accent}>
            Pulls
          </Label>
        </Pressable>
        <View style={styles.grow} />
        {report ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open on GitHub"
            onPress={() => open('pull')}
            style={styles.icon}
          >
            <Icon name="external" size={20} color={palette.accent} strokeWidth={1.9} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        style={styles.grow}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={pulls.refreshing} onRefresh={refresh} tintColor={palette.muted} />}
      >
        {body}
      </ScrollView>
      {bar}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 },
  back: { height: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 2 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 20, gap: 18 },
  head: { gap: 7 },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    height: 26,
    paddingLeft: 7,
    paddingRight: 9,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  title: { lineHeight: 25 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  section: { gap: 7 },
  blocker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 8,
  },
  blockerText: { gap: 1, paddingVertical: 4 },
  agent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 14,
  },
  status: { height: 24, paddingHorizontal: 8, borderRadius: 7, justifyContent: 'center' },
  reviewer: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 14 },
  ago: { width: 30, textAlign: 'right' },
  checks: { paddingTop: 12, paddingBottom: 4, paddingLeft: 12, paddingRight: 14, gap: 6 },
  segments: { flexDirection: 'row', gap: 3 },
  segment: { flex: 1, height: 6, borderRadius: 3 },
  checkLine: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 10 },
  notes: { paddingVertical: 10, paddingHorizontal: 14, gap: 6 },
  bar: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
  },
  missing: { padding: 24, textAlign: 'center' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
