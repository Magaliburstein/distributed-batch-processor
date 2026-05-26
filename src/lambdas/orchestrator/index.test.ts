import { describe, it, expect } from 'vitest';
import { buildSchedules } from './index';
import type { ProviderVolume } from '../../shared/types';

describe('buildSchedules', () => {
  const batchDate = '2024-01-15';

  it('ordena proveedores de mayor a menor volumen', () => {
    const providers: ProviderVolume[] = [
      { proveedor: 'small', count: 100 },
      { proveedor: 'large', count: 900 },
    ];
    const schedules = buildSchedules(providers, batchDate);
    expect(schedules[0].proveedor).toBe('large');
    expect(schedules[1].proveedor).toBe('small');
  });

  it('el proveedor con mayor volumen arranca a medianoche', () => {
    const providers: ProviderVolume[] = [
      { proveedor: 'big', count: 800 },
      { proveedor: 'small', count: 200 },
    ];
    const schedules = buildSchedules(providers, batchDate);
    const midnight = new Date(`${batchDate}T00:00:00Z`);
    expect(schedules[0].startTime.getTime()).toBe(midnight.getTime());
  });

  it('distribuye tiempos proporcionales al volumen en 22 horas', () => {
    const providers: ProviderVolume[] = [
      { proveedor: 'provA', count: 700_000 },
      { proveedor: 'provB', count: 300_000 },
    ];
    const schedules = buildSchedules(providers, batchDate);

    const midnight = new Date(`${batchDate}T00:00:00Z`).getTime();
    const windowMs = 22 * 60 * 60 * 1000;

    expect(schedules[0].startTime.getTime()).toBe(midnight);
    // provB empieza al 70% de la ventana
    const expectedB = midnight + 0.7 * windowMs;
    expect(schedules[1].startTime.getTime()).toBeCloseTo(expectedB, -3);
  });

  it('con un único proveedor arranca a medianoche', () => {
    const providers: ProviderVolume[] = [{ proveedor: 'solo', count: 1_000_000 }];
    const schedules = buildSchedules(providers, batchDate);
    const midnight = new Date(`${batchDate}T00:00:00Z`);
    expect(schedules[0].startTime.getTime()).toBe(midnight.getTime());
  });

  it('todos los timestamps quedan dentro de la ventana de 22h', () => {
    const providers: ProviderVolume[] = [
      { proveedor: 'p1', count: 250_000 },
      { proveedor: 'p2', count: 400_000 },
      { proveedor: 'p3', count: 350_000 },
    ];
    const schedules = buildSchedules(providers, batchDate);

    const midnight = new Date(`${batchDate}T00:00:00Z`).getTime();
    const windowEnd = midnight + 22 * 60 * 60 * 1000;

    for (const s of schedules) {
      expect(s.startTime.getTime()).toBeGreaterThanOrEqual(midnight);
      expect(s.startTime.getTime()).toBeLessThan(windowEnd);
    }
  });

  it('no muta el array original de proveedores', () => {
    const providers: ProviderVolume[] = [
      { proveedor: 'a', count: 100 },
      { proveedor: 'b', count: 900 },
    ];
    const original = [...providers];
    buildSchedules(providers, batchDate);
    expect(providers).toEqual(original);
  });

  it('retorna lista vacía si no hay proveedores', () => {
    expect(buildSchedules([], batchDate)).toEqual([]);
  });

  it('maneja proveedores con igual volumen sin errores', () => {
    const providers: ProviderVolume[] = [
      { proveedor: 'x', count: 500 },
      { proveedor: 'y', count: 500 },
    ];
    const schedules = buildSchedules(providers, batchDate);
    expect(schedules).toHaveLength(2);
    // El segundo debe empezar exactamente 11h después de medianoche
    const midnight = new Date(`${batchDate}T00:00:00Z`).getTime();
    expect(schedules[1].startTime.getTime()).toBe(midnight + 11 * 60 * 60 * 1000);
  });
});
