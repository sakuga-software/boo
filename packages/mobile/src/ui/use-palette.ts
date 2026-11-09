import { useColorScheme } from 'react-native';
import { PALETTES, type Palette } from './theme';

/** The palette of the scheme of the phone: light or dark. */
export const usePalette = (): Palette => PALETTES[useColorScheme() === 'dark' ? 'dark' : 'light'];
