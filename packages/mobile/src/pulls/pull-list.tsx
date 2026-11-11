import type { PullRequestReport } from '@sakuga-software/boo-core/report';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRelayContext } from '../relay/relay-context';
import { Icon } from '../ui/icon';
import { GHOST } from '../ui/icons';
import { BigButton, Card, GroupTitle, Label, Notice } from '../ui/kit';
import type { Palette } from '../ui/theme';
import { formatTime } from '../ui/time';
import { useNow } from '../ui/use-now';
import { usePalette } from '../ui/use-palette';
import { listView, liveBadge } from './list';
import { useMergeToast } from './merge-toast';
import { usePullsContext } from './pulls-context';
import { PullRow } from './pull-row';
import { triage, type Group } from './triage';
import { reportKey } from './view';

const routeOf = (report: PullRequestReport) => {
  const [owner, repo] = report.repo.split('/');
  return { owner: owner!, repo: repo!, number: String(report.number) };
};

/** The ghost of boo: its eyes are open, or closed when nothing needs the person. */
export function Ghost({ palette, size, resting = false }: { palette: Palette; size: number; resting?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={GHOST.body} stroke={palette.accent} strokeWidth={resting ? 1.6 : 1.8} strokeLinejoin="round" />
      {resting ? (
        <Path d={GHOST.restingEyes} stroke={palette.ghostEye} strokeWidth={1.6} strokeLinecap="round" />
      ) : (
        GHOST.eyes.map(([cx, cy, r]) => <Circle key={cx} cx={cx} cy={cy} r={r} fill={palette.ghostEye} />)
      )}
    </Svg>
  );
}

const TITLES: Record<Group, string> = { needs: 'Needs you', ready: 'Ready to merge', reviewing: 'Reviewing' };
const TILES: Record<Group, string> = { needs: 'Needs you', ready: 'Ready', reviewing: 'Reviewing' };

/** The pull requests that the relay follows for the user, in three groups. Pull it down to read it again. */
export function PullList() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const relay = useRelayContext();
  const { pulls, live, refresh } = usePullsContext();
  const toast = useMergeToast();
  const now = useNow();
  const scroll = useRef<ScrollView>(null);
  const [offsets, setOffsets] = useState<Partial<Record<Group, number>>>({});
  const view = listView(pulls);
  const signedIn = relay.state.status === 'signedIn' ? relay.state : undefined;
  const offline = 'stale' in view && view.stale !== undefined;
  const badge = liveBadge(live);

  const open = (report: PullRequestReport) =>
    router.push({ pathname: '/pull/[owner]/[repo]/[number]', params: routeOf(report) });
  const merge = (report: PullRequestReport) =>
    router.push({ pathname: '/merge/[owner]/[repo]/[number]', params: routeOf(report) });

  let liveColor = palette.tones.green;
  let liveText = badge?.text ?? '';
  if (offline && 'at' in view) {
    liveColor = palette.tones.yellow;
    liveText = formatTime(view.at);
  } else if (badge) liveColor = palette.tones[badge.tone];

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
      <Ghost palette={palette} size={22} />
      <Label weight={700} size={22} color={palette.text} style={styles.brand}>
        boo
      </Label>
      <View style={styles.grow} />
      {liveText ? (
        <View
          accessibilityRole="text"
          accessibilityLabel={offline ? `Offline, showing the list of ${liveText}` : badge?.spoken}
          style={styles.live}
        >
          {offline ? (
            <Icon name="wifiOff" size={15} color={liveColor} strokeWidth={2.2} />
          ) : (
            <View style={[styles.liveDot, { backgroundColor: liveColor }]} />
          )}
          <Label weight={600} size={13} color={liveColor}>
            {liveText}
          </Label>
        </View>
      ) : null}
    </View>
  );

  let body;
  if (view.kind === 'first read')
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={palette.muted} />
      </View>
    );
  else if (view.kind === 'failed')
    body = (
      <View style={styles.center}>
        <Label size={15} color={palette.tones.red} lines={4} style={styles.centered}>
          {view.message}
        </Label>
        <BigButton label="Try again" onPress={refresh} bg={palette.accent} fg={palette.onAccent} flex={false} />
      </View>
    );
  else {
    const groups = triage(view.reports, now);
    const counts: Record<Group, number> = {
      needs: groups.needs.length,
      ready: groups.ready.length,
      reviewing: groups.reviewing.length,
    };
    const countColor: Record<Group, string> = {
      needs: counts.needs > 0 ? palette.tones.red : palette.muted,
      ready: palette.tones.green,
      reviewing: palette.tones.cyan,
    };
    const section = (group: Group) => (
      <View
        key={group}
        style={styles.section}
        onLayout={({ nativeEvent }) => {
          const y = nativeEvent.layout.y;
          setOffsets((before) => (before[group] === y ? before : { ...before, [group]: y }));
        }}
      >
        <GroupTitle
          palette={palette}
          title={TITLES[group]}
          count={String(counts[group])}
          countColor={countColor[group]}
        />
        {group === 'needs' && counts.needs === 0 ? (
          <Card palette={palette} style={styles.clear}>
            <Ghost palette={palette} size={28} resting />
            <View style={styles.text}>
              <Label weight={600} size={15} color={palette.text}>
                Nothing needs you
              </Label>
              <Label size={13} color={palette.muted}>
                Agents and reviewers have the rest.
              </Label>
            </View>
          </Card>
        ) : (
          <Card palette={palette}>
            {groups[group].map((report, index) => (
              <PullRow
                key={reportKey(report)}
                report={report}
                group={group}
                index={index}
                palette={palette}
                at={view.at}
                now={now}
                onPress={() => open(report)}
                onMerge={() => merge(report)}
              />
            ))}
          </Card>
        )}
      </View>
    );

    body = (
      <>
        <View style={styles.tiles} accessibilityLabel="Jump to a group">
          {(['needs', 'ready', 'reviewing'] as const).map((group) => (
            <Pressable
              key={group}
              accessibilityRole="button"
              accessibilityLabel={`${counts[group]} ${TILES[group]}`}
              onPress={() => scroll.current?.scrollTo({ y: offsets[group] ?? 0, animated: true })}
              style={({ pressed }) => [
                styles.tile,
                { backgroundColor: palette.surface, boxShadow: palette.cardShadow },
                pressed && styles.pressed,
              ]}
            >
              <Label weight={700} size={19} color={countColor[group]}>
                {String(counts[group])}
              </Label>
              <Label weight={500} size={13} color={palette.text2} style={styles.shrink}>
                {TILES[group]}
              </Label>
            </Pressable>
          ))}
        </View>
        <ScrollView
          ref={scroll}
          style={styles.grow}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={pulls.refreshing} onRefresh={refresh} tintColor={palette.muted} />
          }
        >
          {section('needs')}
          {counts.ready > 0 ? section('ready') : null}
          {counts.reviewing > 0 ? section('reviewing') : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.navigate('/activity')}
            style={({ pressed }) => [
              styles.merged,
              { backgroundColor: palette.surface, boxShadow: palette.cardShadow },
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.mergedIcon}>
              <Icon name="merged" size={14} color={palette.tones.magenta} />
            </View>
            <Label size={14} color={palette.text2} style={styles.grow}>
              {groups.mergedToday === 0 ? 'No merge today' : `${groups.mergedToday} merged today`}
            </Label>
            <Icon name="chevronRight" size={14} color={palette.muted} />
          </Pressable>
        </ScrollView>
      </>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      {header}
      {signedIn?.installUrl ? (
        <View style={styles.banner}>
          <Notice palette={palette} action={{ label: 'Install', onPress: () => relay.install(signedIn.installUrl!) }}>
            <Label size={13} color={palette.noticeText}>
              The boo App is not installed on your accounts
            </Label>
          </Notice>
        </View>
      ) : null}
      {offline && 'at' in view ? (
        <View style={styles.banner}>
          <Notice palette={palette} action={{ label: 'Retry', onPress: refresh }}>
            <Label
              size={13}
              color={palette.noticeText}
              accessibilityLabel={`${view.stale} The list is the one of ${formatTime(view.at)}.`}
            >
              {`Offline · showing ${formatTime(view.at)} · retrying every minute`}
            </Label>
          </Notice>
        </View>
      ) : null}
      {body}
      {toast.merge ? (
        <View accessibilityRole="alert" style={[styles.toast, { backgroundColor: palette.toastBg }]}>
          <Icon name="merged" size={16} color={palette.toastAccent} />
          <Label size={14} color={palette.toastFg} style={styles.grow}>
            <Label weight={700} size={14} color={palette.toastFg}>{`${toast.merge.name} merged`}</Label>
            {toast.merge.branchDeleted ? ' · branch deleted' : ''}
          </Label>
          <Pressable accessibilityRole="button" onPress={() => router.navigate('/activity')} style={styles.toastLink}>
            <Label weight={700} size={14} color={palette.toastAccent}>
              View
            </Label>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
    minHeight: 44,
  },
  brand: { letterSpacing: -0.44 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  banner: { paddingHorizontal: 16, paddingBottom: 10 },
  tiles: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingBottom: 12 },
  tile: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  content: { paddingHorizontal: 16, paddingBottom: 20, gap: 16 },
  section: { gap: 6 },
  clear: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  text: { flex: 1, minWidth: 0, gap: 1 },
  merged: {
    minHeight: 44,
    borderRadius: 14,
    paddingLeft: 12,
    paddingRight: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mergedIcon: { width: 26, alignItems: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  centered: { textAlign: 'center' },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  pressed: { opacity: 0.6 },
  toast: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    paddingVertical: 6,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    boxShadow: '0 10px 30px rgba(10,6,20,0.28)',
  },
  toastLink: { height: 36, paddingHorizontal: 12, justifyContent: 'center' },
});
