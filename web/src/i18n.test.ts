import { describe, expect, it } from 'vitest';

import en from './i18n/en.json';
import zhTW from './i18n/zh-TW.json';

type Dict = { [key: string]: unknown };

/** Flatten a nested dictionary into dotted leaf paths, e.g. "nav.dashboard". */
function leafKeys(dict: Dict, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...leafKeys(value as Dict, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

describe('i18n dictionaries', () => {
  const zhKeys = leafKeys(zhTW as Dict);
  const enKeys = leafKeys(en as Dict);

  it('is not empty', () => {
    expect(zhKeys.length).toBeGreaterThan(0);
  });

  it('has identical deep key sets in zh-TW and en', () => {
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
    expect({ missingInEn, missingInZh }).toEqual({ missingInEn: [], missingInZh: [] });
  });

  it('has no empty translation values', () => {
    const empties: string[] = [];
    const walk = (dict: Dict, prefix = '') => {
      for (const [key, value] of Object.entries(dict)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object') {
          walk(value as Dict, path);
        } else if (typeof value !== 'string' || value.trim() === '') {
          empties.push(path);
        }
      }
    };
    walk(zhTW as Dict);
    walk(en as Dict);
    expect(empties).toEqual([]);
  });
});
