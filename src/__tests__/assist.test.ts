import { describe, expect, it } from 'vitest';
import { lineLitres, splitRoute } from '../modules/trips/trips.assist';

describe('trip prefill helpers', () => {
  it('splits the route separators people actually type', () => {
    expect(splitRoute('IOCL Loni - Chakan MIDC')).toEqual({ from: 'IOCL Loni', to: 'Chakan MIDC' });
    expect(splitRoute('Loni → Chakan')).toEqual({ from: 'Loni', to: 'Chakan' });
    expect(splitRoute('Vashi to Panvel')).toEqual({ from: 'Vashi', to: 'Panvel' });
    expect(splitRoute('Uran/Lohegaon')).toEqual({ from: 'Uran', to: 'Lohegaon' });
  });

  it('keeps hyphenated place names whole and ignores single places', () => {
    expect(splitRoute('Pimpri-Chinchwad to Hinjewadi')).toEqual({ from: 'Pimpri-Chinchwad', to: 'Hinjewadi' });
    expect(splitRoute('Chakan')).toEqual({});
    expect(splitRoute(undefined)).toEqual({});
  });

  it('turns volume lines into litres and ignores other units', () => {
    expect(lineLitres({ quantity: 20, unit: 'KL' })).toBe(20000);
    expect(lineLitres({ quantity: 12.5, unit: 'KL' })).toBe(12500);
    expect(lineLitres({ quantity: 9000, unit: 'litre' })).toBe(9000);
    expect(lineLitres({ quantity: 1, unit: 'trip' })).toBeUndefined();
  });
});
