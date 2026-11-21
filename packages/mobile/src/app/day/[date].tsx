import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  agentShares,
  dateOf,
  dayTitle,
  mergeMinutes,
  shiftDate,
  shortDuration,
  type AgentShare,
  type MergedPull,
} from '../../day/day';
import { useDay } from '../../day/use-day';
import { listView } from '../../pulls/list';
import { PullRow } from '../../pulls/pull-row';
import { usePullsContext } from '../../pulls/pulls-context';
import { shortName, triage } from '../../pulls/triage';
import { reportKey } from '../../pulls/view';
import { accountAvatar, agentAvatar } from '../../ui/avatars';
import { Icon } from '../../ui/icon';
import { AvatarBadge, Card, divider, GroupTitle, Label } from '../../ui/kit';
import { well, type Palette } from '../../ui/theme';
import { formatTime } from '../../ui/time';
import { useNow } from '../../ui/use-now';
import { usePalette } from '../../ui/use-palette';

const FIRST_ROWS = 5;

const routeOf = ({ repo, number }: { repo: string; number: number }) => {
  const [owner, name] = repo.split('/');
  return { owner: owner!, repo: name!, number: String(number) };
};

const shareColor = (palette: Palette, share: AgentShare) =>
  share.tone === 'claude' ? palette.claude : palette.tones[share.tone];

function MergedRow({
  pull,
  index,
  palette,
  onPress,
}: {
  pull: MergedPull;
  index: number;
  palette: Palette;
  onPress: () => void;
}) {
  const avatar = pull.agent
    ? agentAvatar(pull.agent, palette.scheme, palette.claude, well(palette, palette.claude, true))
    : accountAvatar(pull.author ?? pull.mergedBy ?? '?', palette.scheme);
  const rounds = `${pull.reviews} review${pull.reviews === 1 ? '' : 's'}`;
  const meta = `${shortName(pull)} · ${rounds} · ${shortDuration(mergeMinutes(pull))}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pull.title || shortName(pull)}, ${meta}, merged at ${formatTime(new Date(pull.mergedAt))}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, divider(palette, index), pressed && styles.pressed]}
    >
      <AvatarBadge palette={palette} avatar={avatar} size={30} />
      <View style={styles.text}>
        <Label weight={600} size={14} color={palette.text}>
          {pull.title || shortName(pull)}
        </Label>
        <Label size={13} color={palette.muted}>
          {meta}
        </Label>
      </View>
      <Label size={12} color={palette.muted}>
        {formatTime(new Date(pull.mergedAt))}
      </Label>
    </Pressable>
  );
}

function Stat({ palette, value, label, delta }: { palette: Palette; value: string; label: string; delta?: string }) {
  return (
    <View style={[styles.stat, { backgroundColor: palette.surface, boxShadow: palette.cardShadow }]}>
      <Label weight={700} size={26} color={palette.text}>
        {value}
      </Label>
      <Label size={12} color={palette.muted}>
        {label}
      </Label>
      {delta ? (
        <Label weight={600} size={12} color={palette.muted} lines={2}>
          {delta}
        </Label>
      ) : null}
    </View>
  );
}

/**
 * BOO-35: the work of one day. First what stays for tomorrow (today only), then the merges with the
 * share of each agent, then the figures. The chevrons go to the days before, back to the start of the
 * history of the relay.
 */
export default function DayScreen() {
  const params = useLocalSearchParams<{ date: string }>();
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const now = useNow();
  const today = dateOf(now);
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today;
  const { pulls } = usePullsContext();
  const view = listView(pulls);
  const read = useDay(date, 'at' in view ? view.at.getTime() : undefined);
  const [all, setAll] = useState(false);
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/activity'));
  const go = (next: string) => router.setParams({ date: next === today ? 'today' : next });

  const work = read.status === 'ready' ? read.work : undefined;
  const since = work?.historySince ? dateOf(new Date(work.historySince)) : undefined;
  const canGoBack = !since || shiftDate(date, -1) >= since;
  const isToday = date === today;
  const left = isToday && 'reports' in view ? triage(view.reports, now) : undefined;

  const chevron = (icon: 'chevronLeft' | 'chevronRight', enabled: boolean, label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chevron,
        { backgroundColor: palette.surface, boxShadow: palette.cardShadow, opacity: enabled ? 1 : 0.4 },
        pressed && styles.pressed,
      ]}
    >
      <Icon name={icon} size={18} color={palette.muted} strokeWidth={2.4} />
    </Pressable>
  );

  let merged;
  if (read.status === 'loading')
    merged = <ActivityIndicator color={palette.muted} accessibilityLabel="Reading the day" />;
  else if (read.status === 'failed')
    merged = (
      <Label size={14} color={palette.tones.red} lines={3}>
        {read.message}
      </Label>
    );
  else if (work!.merged.length === 0)
    merged = (
      <Card palette={palette} style={styles.empty}>
        <Label weight={600} size={15} color={palette.text}>
          {since && date < since ? `boo keeps the history since ${dayTitle(since, now)}` : 'Nothing merged that day'}
        </Label>
      </Card>
    );
  else {
    const shares = agentShares(work!.merged);
    const total = work!.merged.length;
    const rows = all ? work!.merged : work!.merged.slice(0, FIRST_ROWS);
    merged = (
      <Card palette={palette}>
        <View style={styles.shares}>
          <View style={styles.bar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {shares.map((share) => (
              <View key={share.key} style={{ flex: share.count, backgroundColor: shareColor(palette, share) }} />
            ))}
          </View>
          <View
            style={styles.legend}
            accessible
            accessibilityLabel={shares.map((share) => `${share.label} ${share.count}`).join(', ')}
          >
            {shares.map((share) => (
              <View key={share.key} style={styles.legendItem}>
                <View style={[styles.dot, { backgroundColor: shareColor(palette, share) }]} />
                <Label size={12} color={palette.muted}>
                  {`${share.label} ${share.count}`}
                </Label>
              </View>
            ))}
          </View>
        </View>
        {rows.map((pull, index) => (
          <MergedRow
            key={`${pull.repo}#${pull.number}`}
            pull={pull}
            index={index + 1}
            palette={palette}
            onPress={() => router.push({ pathname: '/pull/[owner]/[repo]/[number]', params: routeOf(pull) })}
          />
        ))}
        {total > FIRST_ROWS && !all ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setAll(true)}
            style={({ pressed }) => [styles.more, divider(palette, 1), pressed && styles.pressed]}
          >
            <Label weight={600} size={14} color={palette.accentText}>
              {`Show ${total - FIRST_ROWS} more`}
            </Label>
          </Pressable>
        ) : null}
      </Card>
    );
  }

  const delta = work ? work.merged.length - work.previousMerged : 0;
  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <Pressable accessibilityRole="button" onPress={leave} hitSlop={8} style={styles.back}>
          <Icon name="chevronLeft" size={20} color={palette.accent} />
          <Label size={16} color={palette.accent}>
            Activity
          </Label>
        </Pressable>
        <View style={styles.titleRow}>
          <Label weight={700} size={22} color={palette.text} style={styles.title}>
            {dayTitle(date, now)}
          </Label>
          {chevron('chevronLeft', canGoBack, 'The day before', () => go(shiftDate(date, -1)))}
          {chevron('chevronRight', !isToday, 'The day after', () => go(shiftDate(date, 1)))}
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {left ? (
          <View style={styles.section}>
            <GroupTitle
              palette={palette}
              title="Left for tomorrow"
              count={String(left.needs.length + left.ready.length)}
              small
            />
            {left.needs.length + left.ready.length === 0 ? (
              <Card palette={palette} style={styles.empty}>
                <Label weight={600} size={15} color={palette.text}>
                  Nothing waits for you
                </Label>
              </Card>
            ) : (
              <Card palette={palette}>
                {[
                  ...left.needs.map((report) => ['needs', report] as const),
                  ...left.ready.map((report) => ['ready', report] as const),
                ].map(([group, report], index) => (
                  <PullRow
                    key={reportKey(report)}
                    report={report}
                    group={group}
                    index={index}
                    palette={palette}
                    at={'at' in view ? view.at : now}
                    now={now}
                    onPress={() => router.push({ pathname: '/pull/[owner]/[repo]/[number]', params: routeOf(report) })}
                    onMerge={() => router.push({ pathname: '/merge/[owner]/[repo]/[number]', params: routeOf(report) })}
                  />
                ))}
              </Card>
            )}
          </View>
        ) : null}
        <View style={styles.section}>
          <GroupTitle palette={palette} title="Merged" count={work ? String(work.merged.length) : ''} small />
          {merged}
        </View>
        {work ? (
          <View style={styles.section}>
            <GroupTitle palette={palette} title="Figures" small />
            <View style={styles.stats}>
              <Stat
                palette={palette}
                value={String(work.merged.length)}
                label="merged"
                {...(delta !== 0 && { delta: `${delta > 0 ? '+' : ''}${delta} vs the day before` })}
              />
              <Stat palette={palette} value={String(work.reviews)} label="reviews" />
              <Stat palette={palette} value={String(work.redChecks)} label="red checks" />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  back: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'flex-start',
    marginLeft: -8,
    paddingHorizontal: 8,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, minHeight: 44, lineHeight: 44, letterSpacing: -0.44 },
  chevron: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 32, gap: 16 },
  section: { gap: 6 },
  empty: { paddingVertical: 20, paddingHorizontal: 12, alignItems: 'center' },
  shares: { paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, gap: 8 },
  bar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingBottom: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12 },
  text: { flex: 1, minWidth: 0, gap: 1 },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexGrow: 1, flexBasis: 96, borderRadius: 14, padding: 12, gap: 2 },
  pressed: { opacity: 0.6 },
});
