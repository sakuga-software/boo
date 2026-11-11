import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActivity } from '../../activity/activity-context';
import { groupByDay, isUnread, type ActivityEvent } from '../../activity/events';
import { accountAvatar } from '../../ui/avatars';
import { Icon } from '../../ui/icon';
import { AvatarBadge, Card, divider, GroupTitle, Label, Pill, Segmented, Well } from '../../ui/kit';
import type { Palette } from '../../ui/theme';
import { formatTime } from '../../ui/time';
import { useNow } from '../../ui/use-now';
import { usePalette } from '../../ui/use-palette';

const routeOf = (event: ActivityEvent) => {
  const [repo, number] = event.key.split('#');
  const [owner, name] = repo!.split('/');
  return { owner: owner!, repo: name!, number: number! };
};

function EventRow({
  event,
  unread,
  index,
  palette,
  onOpen,
  onMerge,
}: {
  event: ActivityEvent;
  unread: boolean;
  index: number;
  palette: Palette;
  onOpen: () => void;
  onMerge: () => void;
}) {
  const color = palette.tones[event.tone];
  return (
    <View style={[styles.row, divider(palette, index)]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${event.what}, ${event.name}, ${event.title}, ${formatTime(new Date(event.at))}${unread ? ', unread' : ''}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        {event.actor ? (
          <AvatarBadge
            palette={palette}
            avatar={accountAvatar(event.actor, palette.scheme)}
            size={30}
            badge={{ icon: event.icon, color }}
          />
        ) : (
          <Well palette={palette} icon={event.icon} color={color} />
        )}
        <View style={styles.text}>
          <Label weight={unread ? 700 : 500} size={14} color={palette.text}>
            {event.what}
          </Label>
          <Label size={13} color={palette.muted}>
            {`${event.name} · ${event.title}`}
          </Label>
        </View>
        <View style={styles.side}>
          <Label size={12} color={palette.muted}>
            {formatTime(new Date(event.at))}
          </Label>
          <View style={[styles.dot, { backgroundColor: unread ? palette.accent : 'transparent' }]} />
        </View>
      </Pressable>
      {event.canMerge ? (
        <Pill
          label="Merge"
          accessibilityLabel={`Merge ${event.name}`}
          onPress={onMerge}
          bg={palette.greenPill}
          fg={palette.greenText}
        />
      ) : null}
    </View>
  );
}

// The activity: the changes of the pull requests that this phone saw, newest first.
export default function ActivityScreen() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { log, unread, readAll } = useActivity();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const now = useNow();
  const events = filter === 'unread' ? log.events.filter((event) => isUnread(log, event)) : log.events;
  const groups = groupByDay(events, now);

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Label weight={700} size={22} color={palette.text} style={styles.title}>
          Activity
        </Label>
        <View style={styles.controls}>
          <View style={styles.grow}>
            <Segmented
              palette={palette}
              label="Filter the activity"
              options={[
                { id: 'all', label: 'All' },
                { id: 'unread', label: `Unread · ${unread}` },
              ]}
              value={filter}
              onChange={setFilter}
              size={14}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark all read"
            onPress={readAll}
            style={({ pressed }) => [
              styles.readAll,
              { backgroundColor: palette.surface, boxShadow: palette.cardShadow },
              pressed && styles.pressed,
            ]}
          >
            <Icon name="readAll" size={20} color={palette.accent} />
          </Pressable>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {groups.length === 0 ? (
          <View style={styles.empty}>
            <Label weight={600} size={15} color={palette.text}>
              You're all caught up
            </Label>
            <Label size={13} color={palette.muted} lines={3} style={styles.centered}>
              New reviews, checks and merges show here.
            </Label>
          </View>
        ) : null}
        {groups.map((group) => (
          <View key={group.label} style={styles.section}>
            <GroupTitle palette={palette} title={group.label} small />
            <Card palette={palette}>
              {group.events.map((event, index) => (
                <EventRow
                  key={event.id}
                  event={event}
                  unread={isUnread(log, event)}
                  index={index}
                  palette={palette}
                  onOpen={() => router.push({ pathname: '/pull/[owner]/[repo]/[number]', params: routeOf(event) })}
                  onMerge={() => router.push({ pathname: '/merge/[owner]/[repo]/[number]', params: routeOf(event) })}
                />
              ))}
            </Card>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  title: { minHeight: 44, lineHeight: 44, letterSpacing: -0.44 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  readAll: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 20, gap: 14 },
  section: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 10 },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingLeft: 12,
  },
  text: { flex: 1, minWidth: 0, gap: 1 },
  side: { alignItems: 'flex-end', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  empty: { paddingVertical: 32, paddingHorizontal: 12, alignItems: 'center', gap: 6 },
  centered: { textAlign: 'center' },
  grow: { flex: 1 },
  pressed: { opacity: 0.6 },
});
