import { describe, expect, it } from 'vitest';
import { leadingNumber, parseNumberInput, precisionForStep, searchNormalized } from '../src/core/numberInput';

describe('parseNumberInput', () => {
  const db = { min: -24, max: 12, unit: 'dB', precision: 0.1 };

  it('reads plain numbers, signs and the unit as shown', () => {
    expect(parseNumberInput('-3.5', db)).toBe(-3.5);
    expect(parseNumberInput('+6 dB', db)).toBe(6);
    expect(parseNumberInput('-6.0dB', db)).toBe(-6);
    expect(parseNumberInput('  2  ', db)).toBe(2);
  });

  it('accepts a decimal comma and a typographic minus', () => {
    expect(parseNumberInput('-3,5', db)).toBe(-3.5);
    expect(parseNumberInput('−4,2 dB', db)).toBe(-4.2);
    expect(parseNumberInput(',5', db)).toBe(0.5);
  });

  it('clamps to the range and rounds to the precision', () => {
    expect(parseNumberInput('40', db)).toBe(12);
    expect(parseNumberInput('-100', db)).toBe(-24);
    expect(parseNumberInput('-3.14159', db)).toBe(-3.1);
    expect(parseNumberInput('0.3', { min: 0, max: 1, precision: 0.1 })).toBe(0.3);
  });

  it('rejects text without a number or with a foreign unit', () => {
    expect(parseNumberInput('', db)).toBeNull();
    expect(parseNumberInput('loud', db)).toBeNull();
    expect(parseNumberInput('-3 Hz', db)).toBeNull();
  });

  it('converts related units', () => {
    const hz = { min: 20, max: 20000, unit: 'Hz', precision: 1 };
    expect(parseNumberInput('1.2 kHz', hz)).toBe(1200);
    expect(parseNumberInput('2k', hz)).toBe(2000);
    expect(parseNumberInput('80 Hz', hz)).toBe(80);
    expect(parseNumberInput('5', hz)).toBe(20);
    const ms = { min: 0, max: 2000, unit: 'ms', precision: 1 };
    expect(parseNumberInput('0.25 s', ms)).toBe(250);
    expect(parseNumberInput('30ms', ms)).toBe(30);
  });

  it('reads ratios, LUFS and percentages', () => {
    expect(parseNumberInput('4:1', { min: 1, max: 20, unit: ':1', precision: 0.1 })).toBe(4);
    expect(parseNumberInput('-16 LUFS', { min: -25, max: -14, unit: 'LUFS', precision: 0.1 })).toBe(-16);
    expect(parseNumberInput('50%', { min: 0, max: 100, unit: '%' })).toBe(50);
  });
});

describe('helpers', () => {
  it('derives the display precision from a slider step', () => {
    expect(precisionForStep(0.01)).toBe(0.01);
    expect(precisionForStep(0.5)).toBe(0.1);
    expect(precisionForStep(1)).toBe(1);
  });

  it('reads the leading number of formatted text', () => {
    expect(leadingNumber('-6.02 dB')).toBe(-6.02);
    expect(leadingNumber('1,5 kHz')).toBe(1.5);
    expect(leadingNumber('Off')).toBeNull();
  });

  it('finds the normalized value of a monotonic display', () => {
    // a plug-in showing -60..0 dB for 0..1
    const show = (v: number) => -60 + 60 * v;
    const v = searchNormalized(-12, show)!;
    expect(show(v)).toBeCloseTo(-12, 3);
    // falling display
    const fall = (v: number) => 100 - 100 * v;
    expect(fall(searchNormalized(25, fall)!)).toBeCloseTo(25, 3);
    // outside the range: the nearer end
    expect(searchNormalized(10, show)).toBe(1);
    expect(searchNormalized(-90, show)).toBe(0);
    // no numbers: give up
    expect(searchNormalized(1, () => null)).toBeNull();
  });
});
