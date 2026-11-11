import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { Pressable, StyleSheet, View } from 'react-native';
import { accountAvatar, agentAvatar } from '../ui/avatars';
import { Icon } from '../ui/icon';
import { AvatarBadge, divider, Label, Pill, Pips, Well } from '../ui/kit';
import { well, type Palette } from '../ui/theme';
import {
  bestScore,
  reviewerGlyph,
  reviewerWords,
  rowMeta,
  shortName,
  stateGlyph,
  stateWords,
  type Group,
} from './triage';

interface RowProps {
  report: PullRequestReport;
  group: Group;
  index: number;
  palette: Palette;
  at: Date;
  now: Date;
  onPress: () => void;
  onMerge: () => void;
}

/** The avatar of the agent of a pull request, if one works on it. */
function AgentMark({ report, palette }: { report: PullRequestReport; palette: Palette }) {
  if (!report.agent.kind) return null;
  const avatar = agentAvatar(report.agent.kind, palette.scheme, palette.claude, well(palette, palette.claude, true));
  return <AvatarBadge palette={palette} avatar={avatar} />;
}

/** The reviewers of a pull request: their avatars, each one with the badge of its status, overlapped. */
function ReviewerStack({ report, palette }: { report: PullRequestReport; palette: Palette }) {
  if (report.reviewers.length === 0) return null;
  return (
    <View style={styles.stack}>
      {report.reviewers.map((reviewer, index) => {
        const glyph = reviewerGlyph(reviewer.mark);
        return (
          <View key={`${index}:${reviewer.login}`} style={styles.overlap}>
            <AvatarBadge
              palette={palette}
              ringed
              avatar={accountAvatar(reviewer.login, palette.scheme)}
              badge={{ icon: glyph.icon, color: palette.tones[glyph.tone] }}
            />
          </View>
        );
      })}
    </View>
  );
}

const spokenPeople = (report: PullRequestReport) =>
  [
    report.agent.kind && `Agent ${report.agent.kind}`,
    report.reviewers.length > 0 &&
      `Reviewers: ${report.reviewers.map((reviewer) => `${accountAvatar(reviewer.login, 'dark').name} ${reviewerWords(reviewer.mark)}`).join(', ')}`,
  ]
    .filter(Boolean)
    .join('. ');

/** One pull request of the list, as a row of its group in the mockup. */
export function PullRow({ report, group, index, palette, at, now, onPress, onMerge }: RowProps) {
  const glyph = stateGlyph(report);
  const tone = palette.tones[glyph.tone];
  const meta = rowMeta(report, group, at, now);
  const state = stateWords(report);
  const spoken = [
    state,
    report.stalled && 'stalled',
    report.stale && 'stale',
    meta.replace(/^ · /, ''),
    report.title,
    spokenPeople(report),
  ]
    .filter(Boolean)
    .join(', ');

  if (group === 'ready') {
    const score = bestScore(report.reviewers);
    return (
      <View style={[styles.readyRow, divider(palette, index)]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={spoken}
          accessibilityHint="Shows the details"
          onPress={onPress}
          style={({ pressed }) => [styles.readyMain, pressed && styles.pressed]}
        >
          <Well palette={palette} icon="check" color={palette.tones.green} />
          <View style={styles.text}>
            <Label weight={500} size={15} color={palette.text}>
              {report.title || 'No title'}
            </Label>
            <View style={styles.metaLine}>
              {score ? (
                <Pips palette={palette} score={score.score} total={score.total} color={palette.tones.green} />
              ) : null}
              <Label size={13} color={palette.muted} style={styles.shrink}>
                {meta}
              </Label>
            </View>
          </View>
          <AgentMark report={report} palette={palette} />
        </Pressable>
        <Pill
          label="Merge"
          accessibilityLabel={`Merge ${shortName(report)}`}
          onPress={onMerge}
          bg={palette.greenPill}
          fg={palette.greenText}
        />
      </View>
    );
  }

  const compact = group === 'reviewing';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Shows the details"
      onPress={onPress}
      style={({ pressed }) => [
        compact ? styles.compactRow : styles.row,
        divider(palette, index),
        pressed && styles.pressed,
      ]}
    >
      <Well
        palette={palette}
        icon={glyph.icon}
        color={tone}
        size={compact ? 26 : 30}
        iconSize={compact ? 14 : 16}
        strokeWidth={compact ? 2.4 : 2.2}
      >
        {report.stalled ? (
          <View style={[styles.zz, { backgroundColor: palette.zzBg, boxShadow: `0 0 0 2px ${palette.surface}` }]}>
            <Icon name="zz" size={12} color={palette.zzFg} strokeWidth={3} />
          </View>
        ) : null}
      </Well>
      <View style={[styles.text, compact && styles.compactText]}>
        <Label weight={500} size={compact ? 14 : 15} color={palette.text}>
          {report.title || 'No title'}
        </Label>
        <Label size={13} color={palette.muted}>
          <Label weight={compact ? 400 : 600} size={13} color={tone}>
            {state}
          </Label>
          {meta}
        </Label>
      </View>
      <View style={styles.people}>
        {compact ? null : <AgentMark report={report} palette={palette} />}
        <ReviewerStack report={report} palette={palette} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12 },
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  readyRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 10 },
  readyMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingLeft: 12,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  compactText: { gap: 1 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 1 },
  shrink: { flexShrink: 1 },
  people: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stack: { flexDirection: 'row', paddingLeft: 6 },
  overlap: { marginLeft: -6 },
  zz: {
    position: 'absolute',
    top: -6,
    right: -8,
    height: 15,
    paddingHorizontal: 3,
    borderRadius: 8,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
});
