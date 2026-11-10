import Svg, { Circle, Path } from 'react-native-svg';
import { ICONS, type IconName, type IconShape } from './icons';

interface IconProps {
  name: IconName;
  size: number;
  color: string;
  strokeWidth?: number;
}

/** An icon of the mockup, stroked in `color`. Hidden from the screen reader: the text next to it says it. */
export function Icon({ name, size, color, strokeWidth = 2 }: IconProps) {
  const shape: IconShape = ICONS[name];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        d={shape.d}
        fill={shape.filled ? color : 'none'}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={shape.dash}
      />
      {shape.circles?.map(([cx, cy, r]) => (
        <Circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} stroke={color} strokeWidth={strokeWidth} fill="none" />
      ))}
    </Svg>
  );
}
