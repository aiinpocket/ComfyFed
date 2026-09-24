import { Group, Select } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useTranslation } from 'react-i18next';

import { RANGE_PRESETS, resolveRange, type RangePreset, type RangeValue } from '../lib/reportRange';

/** Preset dropdown + explicit from/to date-time pickers, shared by every
 * report tab. Picking a preset fills the two fields with its resolved
 * bounds (as of now) so the window is visible; editing either field flips
 * the preset to `custom` and keeps what was typed. */
export function ReportRangeControl({
  value,
  onChange,
}: {
  value: RangeValue;
  onChange: (next: RangeValue) => void;
}) {
  const { t } = useTranslation();
  const [from, to] = resolveRange(value);

  const setBound = (index: 0 | 1, date: Date | null) => {
    const custom: RangeValue['custom'] = [from, to];
    custom[index] = date;
    onChange({ preset: 'custom', custom });
  };

  return (
    <Group gap="sm" wrap="wrap" align="flex-end">
      <Select
        label={t('reports.range_label')}
        value={value.preset}
        onChange={(next) => {
          if (!next) return;
          const preset = next as RangePreset;
          onChange({ preset, custom: preset === 'custom' ? [from, to] : value.custom });
        }}
        data={RANGE_PRESETS.map((preset) => ({ value: preset, label: t(`reports.range_${preset}`) }))}
        allowDeselect={false}
        w={150}
      />
      <DateTimePicker
        label={t('reports.range_from')}
        value={from}
        onChange={(date) => setBound(0, date)}
        valueFormat="YYYY-MM-DD HH:mm"
        placeholder={t('reports.range_blank')}
        maxDate={to ?? undefined}
        clearable
        clearButtonProps={{ 'aria-label': t('reports.range_clear_from') }}
        w={190}
      />
      <DateTimePicker
        label={t('reports.range_to')}
        value={to}
        onChange={(date) => setBound(1, date)}
        valueFormat="YYYY-MM-DD HH:mm"
        placeholder={t('reports.range_blank')}
        minDate={from ?? undefined}
        clearable
        clearButtonProps={{ 'aria-label': t('reports.range_clear_to') }}
        w={190}
      />
    </Group>
  );
}
