import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { Avatar } from './avatars';
import { font, type Weight } from './fonts';
import { Icon } from './icon';
import type { IconName } from './icons';
import { well, type Palette } from './theme';

// The parts that the screens of the mockup "boo mobile, refonte" share.

interface LabelProps {
  children: ReactNode;
  weight?: Weight;
  size: number;
  color: string;
  lines?: number;
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}

/** A text in Hanken Grotesk, with the figures of a table. One line by default, cut with an ellipsis. */
export function Label({ children, weight = 400, size, color, lines = 1, style, accessibilityLabel }: LabelProps) {
  return (
    <Text
      numberOfLines={lines}
      accessibilityLabel={accessibilityLabel}
      style={[font(weight, size), styles.figures, { color }, style]}
    >
      {children}
    </Text>
  );
}

/** A card of rows: the surface, the radius of 14, and the shadow of the light scheme. */
export function Card({
  palette,
  children,
  style,
}: {
  palette: Palette;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.card, { backgroundColor: palette.surface, boxShadow: palette.cardShadow }, style]}>
      {children}
    </View>
  );
}

/** The line above each row of a card but the first. */
export const divider = (palette: Palette, index: number): ViewStyle =>
  index === 0 ? {} : { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: palette.line };

/** The title of a group of the list, and its count in a tone. */
export function GroupTitle({
  palette,
  title,
  count,
  countColor,
  countWeight = 700,
  small = false,
}: {
  palette: Palette;
  title: string;
  count?: string;
  countColor?: string;
  countWeight?: Weight;
  small?: boolean;
}) {
  return (
    <View accessibilityRole="header" style={styles.groupTitle}>
      <Label weight={small ? 600 : 700} size={small ? 13 : 15} color={small ? palette.text2 : palette.text}>
        {title}
      </Label>
      {count !== undefined ? (
        <Label weight={countWeight} size={13} color={countColor ?? palette.muted}>
          {count}
        </Label>
      ) : null}
    </View>
  );
}

/** An icon on a tint of its color, in a rounded square: the mark of a state. */
export function Well({
  palette,
  icon,
  color,
  size = 30,
  iconSize = 16,
  strokeWidth = 2.4,
  round = false,
  children,
}: {
  palette: Palette;
  icon: IconName;
  color: string;
  size?: number;
  iconSize?: number;
  strokeWidth?: number;
  round?: boolean;
  children?: ReactNode;
}) {
  return (
    <View
      style={[
        styles.center,
        {
          width: size,
          height: size,
          borderRadius: round ? size / 2 : size * 0.3,
          backgroundColor: well(palette, color),
        },
      ]}
    >
      <Icon name={icon} size={iconSize} color={color} strokeWidth={strokeWidth} />
      {children}
    </View>
  );
}

// The letters of an avatar of 28, 22 and 20, as the mockup sizes them.
const monoSize = (size: number) => {
  if (size >= 28) return 10;
  return size >= 22 ? 8.5 : 8;
};

/** A round avatar, with the badge of a status at its bottom right. */
export function AvatarBadge({
  palette,
  avatar,
  size = 22,
  badge,
  ringed = false,
}: {
  palette: Palette;
  avatar: Avatar;
  size?: number;
  badge?: { icon: IconName; color: string };
  ringed?: boolean;
}) {
  const badgeSize = size >= 28 ? 15 : 13;
  return (
    <View
      style={[
        styles.center,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: avatar.bg,
          boxShadow: ringed ? `0 0 0 2px ${palette.surface}` : undefined,
        },
      ]}
    >
      {avatar.claude ? (
        <Icon name="claude" size={Math.round(size * 0.55)} color={avatar.fg} strokeWidth={2.6} />
      ) : (
        <Label weight={700} size={monoSize(size)} color={avatar.fg}>
          {avatar.mono}
        </Label>
      )}
      {badge ? (
        <View
          style={[
            styles.center,
            styles.badge,
            {
              width: badgeSize,
              height: badgeSize,
              borderRadius: badgeSize / 2,
              backgroundColor: badge.color,
              boxShadow: `0 0 0 2px ${palette.surface}`,
            },
          ]}
        >
          <Icon name={badge.icon} size={badgeSize === 15 ? 10 : 9} color={palette.surface} strokeWidth={3.5} />
        </View>
      ) : null}
    </View>
  );
}

/** The dots of a score: `score` of `total` lit in `color`. */
export function Pips({
  palette,
  score,
  total,
  color,
}: {
  palette: Palette;
  score: number;
  total: number;
  color: string;
}) {
  // A score on 10 shows on 5 dots, as the mockup draws every score.
  const lit = Math.round((score / total) * 5);
  return (
    <View style={styles.pips}>
      {[0, 1, 2, 3, 4].map((index) => (
        <View key={index} style={[styles.pip, { backgroundColor: index < lit ? color : palette.pipOff }]} />
      ))}
    </View>
  );
}

/** A small pill button on a row, such as Merge, Re-run or Open. */
export function Pill({
  label,
  onPress,
  bg,
  fg,
  icon,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  bg: string;
  fg: string;
  icon?: IconName;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.pillTarget, pressed && styles.pressed]}
    >
      <View style={[styles.pill, icon ? styles.pillWithIcon : null, { backgroundColor: bg }]}>
        {icon ? <Icon name={icon} size={13} color={fg} strokeWidth={2.4} /> : null}
        <Label weight={600} size={icon ? 13 : 14} color={fg}>
          {label}
        </Label>
      </View>
    </Pressable>
  );
}

/** The switch of the mockup: 51 × 31, green when on. */
export function Toggle({
  palette,
  value,
  onChange,
  label,
  disabled = false,
}: {
  palette: Palette;
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={[
        styles.toggle,
        {
          backgroundColor: value ? palette.tones.green : palette.switchOff,
          justifyContent: value ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View style={styles.knob} />
    </Pressable>
  );
}

/** A control of two or three segments, such as the merge method or the filter of the activity. */
export function Segmented<T extends string>({
  palette,
  options,
  value,
  onChange,
  label,
  height = 36,
  size = 13,
  disabled = false,
}: {
  palette: Palette;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  height?: number;
  size?: number;
  disabled?: boolean;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.track, { backgroundColor: palette.track }]}
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.id)}
            style={[
              styles.segment,
              {
                height,
                backgroundColor: on ? palette.segOn : 'transparent',
                boxShadow: on ? palette.segShadow : undefined,
              },
            ]}
          >
            <Label weight={600} size={size} color={on ? palette.text : palette.muted}>
              {option.label}
            </Label>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A yellow notice, with an optional button at its end. */
export function Notice({
  palette,
  icon,
  children,
  action,
}: {
  palette: Palette;
  icon?: IconName;
  children: ReactNode;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={[styles.notice, action ? styles.noticeWithAction : null, { backgroundColor: palette.noticeBg }]}>
      {icon ? <Icon name={icon} size={16} color={palette.noticeText} strokeWidth={2.2} /> : null}
      <View style={styles.grow}>{children}</View>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          style={({ pressed }) => [
            styles.noticeButton,
            { backgroundColor: palette.noticeButton },
            pressed && styles.pressed,
          ]}
        >
          <Label weight={700} size={13} color={palette.noticeText}>
            {action.label}
          </Label>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A large button of an action bar or a sheet: 48 high, round. */
export function BigButton({
  label,
  onPress,
  bg,
  fg,
  icon,
  disabled = false,
  weight = 700,
  size = 15,
  flex = true,
}: {
  label: string;
  onPress: () => void;
  bg: string;
  fg: string;
  icon?: IconName;
  disabled?: boolean;
  weight?: Weight;
  size?: number;
  flex?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.big,
        flex ? styles.grow : styles.bigFit,
        { backgroundColor: bg },
        pressed && styles.pressed,
      ]}
    >
      {icon ? <Icon name={icon} size={15} color={fg} strokeWidth={2.3} /> : null}
      <Label weight={weight} size={size} color={fg}>
        {label}
      </Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  figures: { fontVariant: ['tabular-nums'] },
  card: { borderRadius: 14, overflow: 'hidden' },
  groupTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingHorizontal: 2 },
  center: { alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', right: -4, bottom: -4 },
  pips: { flexDirection: 'row', gap: 2 },
  pip: { width: 6, height: 6, borderRadius: 3 },
  pillTarget: { height: 44, justifyContent: 'center' },
  pill: { height: 32, paddingHorizontal: 14, borderRadius: 16, flexDirection: 'row', alignItems: 'center' },
  pillWithIcon: { paddingLeft: 9, paddingRight: 11, gap: 5 },
  pressed: { opacity: 0.6 },
  toggle: { width: 51, height: 31, padding: 2, borderRadius: 16, flexDirection: 'row' },
  knob: {
    width: 27,
    height: 27,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    boxShadow: '0 2px 4px rgba(10,6,20,0.25)',
  },
  track: { flexDirection: 'row', padding: 3, gap: 3, borderRadius: 12 },
  segment: { flex: 1, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  noticeWithAction: { paddingVertical: 4, paddingRight: 4 },
  noticeButton: { height: 36, paddingHorizontal: 12, borderRadius: 18, justifyContent: 'center' },
  grow: { flex: 1, minWidth: 0 },
  big: { height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  bigFit: { paddingHorizontal: 18 },
});
