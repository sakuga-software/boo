import { Pressable, StyleSheet } from 'react-native';
import { Label } from './kit';
import type { Palette } from './theme';

interface ButtonProps {
  label: string;
  onPress: () => void;
  palette: Palette;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
}

/** A button of the sign-in and of the editors: the accent, or the second surface. */
export function Button({ label, onPress, palette, kind = 'primary', disabled = false }: ButtonProps) {
  const primary = kind === 'primary';
  let bg = primary ? palette.accent : palette.surface2;
  let fg = primary ? palette.onAccent : palette.text2;
  if (disabled) [bg, fg] = [palette.disabledBg, palette.disabledFg];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg }, pressed && styles.pressed]}
    >
      <Label weight={primary ? 700 : 600} size={15} color={fg} style={styles.text}>
        {label}
      </Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minWidth: 260, height: 48, borderRadius: 24, paddingHorizontal: 20, justifyContent: 'center' },
  text: { textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
