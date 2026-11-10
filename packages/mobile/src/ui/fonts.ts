// One import for each weight: the index of the package would bundle all of its 18 files.
import { HankenGrotesk_400Regular } from '@expo-google-fonts/hanken-grotesk/400Regular';
import { HankenGrotesk_500Medium } from '@expo-google-fonts/hanken-grotesk/500Medium';
import { HankenGrotesk_600SemiBold } from '@expo-google-fonts/hanken-grotesk/600SemiBold';
import { HankenGrotesk_700Bold } from '@expo-google-fonts/hanken-grotesk/700Bold';

export const FONT_FILES = {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
};

export type Weight = 400 | 500 | 600 | 700;

const FAMILY: Record<Weight, keyof typeof FONT_FILES> = {
  400: 'HankenGrotesk_400Regular',
  500: 'HankenGrotesk_500Medium',
  600: 'HankenGrotesk_600SemiBold',
  700: 'HankenGrotesk_700Bold',
};

/**
 * The style of a text of `size` in Hanken Grotesk. React Native draws no weight of a custom font: each
 * weight is its own family.
 */
export const font = (weight: Weight, size: number) => ({ fontFamily: FAMILY[weight], fontSize: size });
