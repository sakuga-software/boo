import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActivity } from '../activity/activity-context';
import { useRelayContext } from '../relay/relay-context';
import { Icon } from './icon';
import type { IconName } from './icons';
import { Label } from './kit';
import { usePalette } from './use-palette';

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const TABS: Record<string, { label: string; icon: IconName }> = {
  index: { label: 'Pulls', icon: 'tabPulls' },
  activity: { label: 'Activity', icon: 'tabActivity' },
  settings: { label: 'Settings', icon: 'tabSettings' },
};

/** The bar of the three tabs, as the mockup draws it. A signed-out person sees no bar: only the sign-in. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const relay = useRelayContext();
  const { unread } = useActivity();
  if (relay.state.status !== 'signedIn') return null;
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        { paddingBottom: Math.max(insets.bottom, 8), backgroundColor: palette.bar, borderTopColor: palette.barLine },
      ]}
    >
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === index;
        const color = focused ? palette.accent : palette.muted;
        const badge = route.name === 'activity' && unread > 0 ? unread : 0;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={badge ? `${tab.label}, ${badge} unread` : tab.label}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.tab}
          >
            <Icon name={tab.icon} size={22} color={color} strokeWidth={1.8} />
            <Label weight={focused ? 600 : 500} size={11} color={color}>
              {tab.label}
            </Label>
            {badge ? (
              <View style={[styles.badge, { backgroundColor: palette.accent }]}>
                <Label weight={700} size={10} color={palette.onAccent}>
                  {badge > 99 ? '99+' : String(badge)}
                </Label>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', paddingTop: 4, paddingHorizontal: 8, borderTopWidth: StyleSheet.hairlineWidth * 2 },
  tab: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', gap: 2 },
  badge: {
    position: 'absolute',
    top: 0,
    left: '50%',
    marginLeft: 5,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
