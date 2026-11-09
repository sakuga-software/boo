import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRelayContext } from '../relay/relay-context';
import { Button } from '../ui/button';
import { formatTime } from '../ui/time';
import { usePalette } from '../ui/use-palette';
import { listView, liveBadge } from './list';
import { usePullsContext } from './pulls-context';
import { PullRow } from './pull-row';
import { reportKey } from './view';

/** The list of the pull requests that the relay follows for the user. Pull it down to read it again. */
export function PullList() {
  const palette = usePalette();
  const router = useRouter();
  const relay = useRelayContext();
  const { pulls, live, refresh } = usePullsContext();
  const badge = liveBadge(live);
  const view = listView(pulls);
  const signedIn = relay.state.status === 'signedIn' ? relay.state : undefined;
  const muted = { color: palette.muted };
  const refreshControl = <RefreshControl refreshing={pulls.refreshing} onRefresh={refresh} tintColor={palette.muted} />;

  const header = (
    <View style={[styles.header, { borderColor: palette.border }]}>
      <View style={styles.headerText}>
        <Text style={[styles.title, { color: palette.text }]}>boo</Text>
        <Text style={[styles.small, muted]}>
          {badge ? (
            <Text
              accessibilityLabel={badge.spoken}
              style={[styles.badge, { color: palette.tones[badge.tone] }]}
            >{`${badge.text} · `}</Text>
          ) : null}
          {'at' in view ? `Updated at ${formatTime(view.at)}` : 'Reading the relay…'}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Account of ${signedIn?.connection.login ?? ''}`}
        hitSlop={12}
        onPress={() => router.push('/account')}
      >
        <Text style={[styles.account, { color: palette.tones.blue }]}>{signedIn?.connection.login}</Text>
      </Pressable>
    </View>
  );

  const banners = (
    <>
      {signedIn?.installUrl ? (
        <Pressable accessibilityRole="button" onPress={() => router.push('/account')}>
          <Text style={[styles.banner, { color: palette.tones.yellow, backgroundColor: palette.surface }]}>
            The boo App is not installed on any account that you can read. Open the account to install it.
          </Text>
        </Pressable>
      ) : null}
      {view.kind !== 'first read' && view.kind !== 'failed' && view.stale ? (
        <Text style={[styles.banner, { color: palette.tones.yellow, backgroundColor: palette.surface }]}>
          {view.stale} The list is the one of {formatTime(view.at)}.
        </Text>
      ) : null}
    </>
  );

  let body;
  if (view.kind === 'first read')
    body = (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  else if (view.kind === 'failed')
    body = (
      <View style={styles.center}>
        <Text style={[styles.message, { color: palette.tones.red }]}>{view.message}</Text>
        <Button label="Try again" onPress={refresh} palette={palette} />
      </View>
    );
  else
    body = (
      <FlatList
        data={view.reports}
        keyExtractor={reportKey}
        renderItem={({ item }) => {
          const [owner, repo] = item.repo.split('/');
          return (
            <PullRow
              report={item}
              palette={palette}
              onPress={() =>
                router.push({
                  pathname: '/pull/[owner]/[repo]/[number]',
                  params: { owner: owner!, repo: repo!, number: String(item.number) },
                })
              }
            />
          );
        }}
        refreshControl={refreshControl}
        contentContainerStyle={view.kind === 'empty' && styles.grow}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={[styles.message, { color: palette.text }]}>No pull request to show.</Text>
            <Text style={[styles.small, styles.centered, muted]}>
              The relay lists the open pull requests of the authors in your settings. Pull down to read it again.
            </Text>
          </View>
        }
      />
    );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: palette.background }]}>
      {header}
      {banners}
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: { flex: 1 },
  title: { fontSize: 28, fontWeight: '700' },
  account: { fontSize: 16, fontWeight: '600' },
  small: { fontSize: 13 },
  badge: { fontWeight: '600' },
  banner: { fontSize: 14, paddingHorizontal: 16, paddingVertical: 10 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  centered: { textAlign: 'center' },
  message: { fontSize: 16, textAlign: 'center' },
  grow: { flexGrow: 1 },
});
