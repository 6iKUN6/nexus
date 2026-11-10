import { Radio, Tooltip } from '@arco-design/web-react';
import { IconDesktop, IconMoon, IconSun } from '@arco-design/web-react/icon';
import type { ThemePreference } from '../theme/themePreference';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  { value: 'system', label: '跟随系统', icon: <IconDesktop /> },
  { value: 'light', label: '浅色', icon: <IconSun /> },
  { value: 'dark', label: '深色', icon: <IconMoon /> },
];

export function ThemeSwitcher({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  return (
    <Radio.Group
      type="button"
      size="mini"
      value={value}
      onChange={(next: ThemePreference) => onChange(next)}
      aria-label="外观"
    >
      {OPTIONS.map((option) => (
        // Tooltip wraps a DOM node inside Radio: Arco's Trigger needs a real
        // element ref because React 19 removed findDOMNode.
        <Radio key={option.value} value={option.value} aria-label={option.label}>
          <Tooltip content={option.label} mini>
            <span className="inline-flex">{option.icon}</span>
          </Tooltip>
        </Radio>
      ))}
    </Radio.Group>
  );
}
