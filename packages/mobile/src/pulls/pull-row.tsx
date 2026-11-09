import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { CLAUDE, type Palette } from '../ui/theme';
import { agentBadge, checksBadge, reviewerChips, stackHint, stateView } from './view';

// The checks of a pull request that left the list, or that the relay could not read, are not counted.
const NO_CHECKS = new Set(['error', 'merged', 'closed']);

/** One pull request, as a row of the list of boo in the terminal: the state, the name, the title, and the badges. */
export function PullRow({ report, palette }: { report: PullRequestReport; palette: Palette }) {
  const state = stateView(report);
  const checks = NO_CHECKS.has(report.state) ? undefined : checksBadge(report.checks);
  const hint = stackHint(report.stack);
  const agent = agentBadge(report.agent);
  const chips = reviewerChips(report.reviewers);
  const tone = palette.tones[state.tone];
  const muted = { color: palette.muted };
  const name = `${report.repo}#${report.number}`;
  const spoken = [state.label, state.stale && 'stale', name, report.title, checks?.text, hint, agent?.name]
    .filter(Boolean)
    .join(', ');
  return (
    <View accessible accessibilityLabel={spoken} style={[styles.row, { borderColor: palette.border }]}>
      <View style={styles.line}>
        <View style={styles.mark}>
          {state.spins ? (
            <ActivityIndicator size="small" color={tone} />
          ) : (
            <Text style={[styles.markText, { color: tone }]}>{state.mark}</Text>
          )}
        </View>
        <Text style={[styles.label, { color: tone }, state.stale && styles.stale]} numberOfLines={1}>
          {state.label}
        </Text>
        {state.stale ? <Text style={[styles.small, muted]}>stale</Text> : null}
        <View style={styles.grow} />
        {checks ? (
          <Text
            style={[styles.small, styles.badge, { color: palette.tones[checks.tone] }, checks.dim && styles.dim]}
            numberOfLines={1}
          >
            {checks.text}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.title, { color: palette.text }]} numberOfLines={2}>
        {report.title || 'No title'}
      </Text>
      <View style={styles.meta}>
        <Text style={[styles.small, styles.name, { color: palette.text }]}>{name}</Text>
        {hint ? <Text style={[styles.small, { color: palette.tones.magenta }]}>{hint}</Text> : null}
        {agent ? (
          <Text style={[styles.small, muted]}>
            <Text style={{ color: agent.claude ? CLAUDE : palette.muted }}>{agent.mark}</Text> {agent.name}
          </Text>
        ) : null}
        {report.stalled ? <Text style={[styles.small, { color: palette.tones.yellow }]}>zZ stalled</Text> : null}
        {chips.map((chip, index) => (
          <Text key={`${index}:${chip.name}`} style={[styles.small, muted]}>
            <Text style={{ color: palette.tones[chip.tone] }}>{chip.mark}</Text> {chip.name}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 12, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mark: { width: 20, alignItems: 'center' },
  markText: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  stale: { fontWeight: '400', opacity: 0.7 },
  grow: { flex: 1 },
  badge: { flexShrink: 0 },
  dim: { opacity: 0.8 },
  title: { fontSize: 16, marginLeft: 26 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2, marginLeft: 26 },
  small: { fontSize: 13, fontVariant: ['tabular-nums'] },
  name: { fontWeight: '600' },
});
